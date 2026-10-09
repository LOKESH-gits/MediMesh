/* ================= DATABASE + ALGORITHMS ================= */
let DB=null,saveT=0;
function save(){clearTimeout(saveT);saveT=setTimeout(()=>store.set('mm_db4',DB),120)}
async function initDB(){
 DB=store.get('mm_db4');
 if(!DB||DB.v!==4){DB=seed();for(const u of DB.users){u.salt=uid('s');u.hash=await sha256(u.salt+u.pw);delete u.pw}refreshAlerts(true);await audit(null,'System initialised (demo data seeded)','-')}
 save();
}
const vName=id=>DB.villages.find(v=>v.id===id)?.name||id;
const vBy=id=>DB.villages.find(v=>v.id===id);
const facBy=id=>DB.facilities.find(f=>f.id===id);

/* ---- Health Shadow Radar: robust baseline → z-score → EWMA + CUSUM per stream → corroboration fusion ---- */
function radarStream(arr){
 const base=arr.slice(0,9),med=median(base),mad=median(base.map(x=>Math.abs(x-med)))*1.4826;
 const sigma=Math.max(mad,.15*Math.max(med,1),1);
 const z=arr.map(x=>(x-med)/sigma);let e=z[0],c=0;
 const ew=z.map(v=>e=.5*v+.5*e),cs=z.map(v=>c=Math.max(0,c+v-.5));
 return{med,sigma,z,ew,cs,zLast:z[z.length-1],ewLast:ew[ew.length-1],csLast:cs[cs.length-1],pct:(mean(arr.slice(-3))/Math.max(med,.5)-1)*100};
}
function radarSyn(v,syn){
 const W={school:syn==='diarrhea'?.5:1,pharmacy:1.2,asha:1.3,clinic:1.5};
 const parts=SRC.map(src=>{const arr=DB.signals[v][syn][src],r=radarStream(arr);return{src,arr,r,w:W[src],score:clamp(Math.max(r.ewLast,r.csLast/5)/3.5,0,1)}});
 const wm=sum(parts.map(p=>p.score*p.w))/sum(parts.map(p=>p.w)),agree=parts.filter(p=>p.r.zLast>=2).length;
 const risk=Math.round(100*(.65*wm+.35*agree/4)),level=risk>=55?'high':risk>=28?'increasing':'normal';
 return{v,syn,parts,wm,agree,risk,level,pct:Math.round(clamp(mean(parts.map(p=>p.r.pct)),-100,300))};
}
const LV_L={high:'High risk',increasing:'Increasing',normal:'Normal'};
function ashaFor(v){return DB.users.filter(u=>u.role==='asha'&&u.active&&u.villages?.includes(v))}
function notify(to,text,icon='bell'){DB.notifs.unshift({id:uid('n'),to,text,t:Date.now(),read:false,icon})}
function addTask(o){DB.tasks.unshift({id:uid('t'),done:false,due:Date.now(),priority:'medium',...o})}
function refreshAlerts(quiet){
 DB.villages.forEach(v=>SYN.forEach(s=>{
  const r=radarSyn(v.id,s),cur=DB.alerts.find(a=>a.v===v.id&&a.syn===s&&a.status!=='resolved');
  if(r.level==='normal'){if(cur){cur.status='resolved';cur.tEnd=Date.now()}return}
  if(cur){cur.level=r.level;cur.risk=r.risk;cur.pct=r.pct;return}
  const a={id:uid('al'),v:v.id,syn:s,level:r.level,risk:r.risk,pct:r.pct,t:Date.now(),status:'open',assigned:null,agree:r.agree};DB.alerts.unshift(a);
  if(!quiet){notify('role:officer',`Risk signal in ${v.name}: ${SYN_L[s].toLowerCase()} indicators ${r.level==='high'?'high':'rising'} across ${r.agree} sources — verification required.`,'radar');ashaFor(v.id).forEach(u=>{addTask({ashaId:u.id,type:'signal',village:v.id,text:`Community ${s} signal in ${v.name} — verify with households`,priority:r.level==='high'?'high':'medium'});notify('user:'+u.id,`New ${s} signal in ${v.name} needs household verification.`,'radar')});notify('role:doctor',`Expect higher ${s} caseload from ${v.name}.`,'stetho')}
 }));
}
function geoMetrics(user){
 const vs=user.role==='asha'?DB.villages.filter(v=>user.villages.includes(v.id)):DB.villages;
 return vs.map(v=>{
  const syn=Object.fromEntries(SYN.map(s=>[s,radarSyn(v.id,s)])),top=SYN.map(s=>syn[s]).sort((a,b)=>b.risk-a.risk)[0];
  const cov=['pcm','ors'].map(m=>DB.inventory[v.id][m]).map(x=>x.qty/x.demand),minCov=Math.min(...cov);
  const pts=DB.patients.filter(p=>p.village===v.id),wait=pts.filter(p=>p.queue==='waiting').length,openT=DB.tasks.filter(t=>!t.done&&(t.village===v.id||pts.some(p=>p.id===t.pid))).length;
  const workload=openT+wait>=6?'HIGH':openT+wait>=3?'MEDIUM':'LOW';
  const nearest=DB.ambulances.filter(a=>a.status==='available').map(a=>hav(a,v)).sort((a,b)=>a-b)[0];
  return{v,syn,top,minCov,stock:minCov<5?'LOW':minCov<10?'WATCH':'OK',workload,cases:pts.length,waiting:wait,amb:nearest==null?'BUSY':'AVAILABLE',ambEta:nearest==null?null:Math.round(nearest*1.3/45*60+3)};
 });
}

/* ---- Federated village intelligence: local stats → clip → Laplace DP noise → pairwise-mask secure aggregation → FedAvg ---- */
function fedRound(eps,seedN){
 const R=rng(seedN),lap=b=>{const u=R()-.5;return-b*Math.sign(u)*Math.log(1-2*Math.abs(u))};
 const vs=DB.villages,tp=sum(vs.map(v=>v.pop)),n=vs.length;
 const local=vs.map(v=>({v,vec:SYN.map(s=>clamp(radarSyn(v.id,s).pct,-100,100))}));
 const noisy=local.map(l=>l.vec.map(x=>x+lap(12/eps)));
 const M=Array.from({length:n},()=>Array.from({length:n},()=>SYN.map(()=>(R()-.5)*2000)));
 const masked=noisy.map((vec,i)=>vec.map((x,k)=>{let w=x*vs[i].pop/tp;for(let j=0;j<n;j++){if(j>i)w+=M[i][j][k];if(j<i)w-=M[j][i][k]}return w}));
 const global=SYN.map((_,k)=>sum(masked.map(m=>m[k]))),truth=SYN.map((_,k)=>sum(local.map(l=>l.vec[k]*l.v.pop/tp)));
 return{local,noisy,masked,global,truth,eps,tp};
}

/* ---- AI Resource & Referral Optimizer: hard constraints + TOPSIS multi-criteria ranking ---- */
function topsis(rows,w,benefit){
 const k=w.length,norm=Array.from({length:k},(_,j)=>Math.sqrt(sum(rows.map(r=>r[j]**2)))||1);
 const V=rows.map(r=>r.map((x,j)=>x/norm[j]*w[j]));
 const best=Array.from({length:k},(_,j)=>{const c=V.map(r=>r[j]);return benefit[j]?Math.max(...c):Math.min(...c)});
 const worst=Array.from({length:k},(_,j)=>{const c=V.map(r=>r[j]);return benefit[j]?Math.min(...c):Math.max(...c)});
 return V.map(r=>{const dp=Math.sqrt(sum(r.map((x,j)=>(x-best[j])**2))),dm=Math.sqrt(sum(r.map((x,j)=>(x-worst[j])**2)));return dp+dm?dm/(dp+dm):.5});
}
const WPRESET={emergency:[.4,.15,.2,.1,.15],urgent:[.3,.15,.2,.15,.2],routine:[.15,.2,.2,.2,.25]};
function optimize({v,service,urgency,w}){
 const o=vBy(v),W=w||WPRESET[urgency]||WPRESET.urgent,cand=[],out=[];
 const anyAmb=DB.ambulances.some(a=>a.status==='available');
 DB.facilities.forEach(f=>{
  const st=f.services[service];if(st==='unavailable'){out.push({f,excluded:`${SVC_L[service]} is currently unavailable`});return}
  const km=hav(o,f),mins=Math.round(km*1.3/40*60+(urgency==='routine'?0:anyAmb?4:18));
  cand.push({f,km,mins,row:[mins,f.beds.free,f.doctors.on,f.medAvail,st==='available'?1:.5]});
 });
 if(!cand.length)return{ranked:[],excluded:out};
 const sc=topsis(cand.map(c=>c.row),W,[false,true,true,true,true]);
 const ranked=cand.map((c,i)=>({...c,score:Math.round(sc[i]*100)})).sort((a,b)=>b.score-a.score);
 ranked.forEach(r=>{const why=[];why.push(`${SVC_L[service]} ${r.f.services[service]}`);why.push(`~${r.mins} min`);why.push(`${r.f.beds.free} beds free`);why.push(`${r.f.doctors.on} doctor${r.f.doctors.on===1?'':'s'} on duty`);why.push(`${r.f.medAvail}% medicines in stock`);r.why=why});
 return{ranked,excluded:out,w:W};
}

/* ---- Voice memory NLP: multilingual lexicon + number words + fuzzy village match ---- */
const LEX={fever:['fever','jwar','காய்ச்சல்','बुखार','জ্বর'],vomiting:['vomit','வாந்தி','उल्टी','বমি'],diarrhea:['diarrh','loose motion','வயிற்றுப்போக்கு','दस्त','ডায়রিয়া','পাতলা পায়খানা'],cough:['cough','இருமல்','खांसी','खाँसी','কাশি'],breath:['breath','மூச்சு','सांस','শ্বাস']};
const NUMW={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,fifteen:15,twenty:20,'ஒன்று':1,'ஒரு':1,'இரண்டு':2,'மூன்று':3,'நான்கு':4,'ஐந்து':5,'ஆறு':6,'ஏழு':7,'எட்டு':8,'ஒன்பது':9,'பத்து':10,'एक':1,'दो':2,'तीन':3,'चार':4,'पांच':5,'पाँच':5,'छह':6,'छः':6,'सात':7,'आठ':8,'नौ':9,'दस':10,'এক':1,'দুই':2,'তিন':3,'চার':4,'পাঁচ':5,'ছয়':6,'সাত':7,'আট':8,'নয়':9,'দশ':10};
function lev(a,b){const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);for(let j=1;j<=b.length;j++)d[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[a.length][b.length]}
function parseReport(text,vs){
 const raw=text.trim(),low=raw.toLowerCase();let village=null,best=9;
 vs.forEach(v=>{if(low.includes(v.name.toLowerCase())||raw.includes(v.ta.slice(0,-1))||(v.alt||[]).some(a=>raw.includes(a.slice(0,-1)))){village=v;best=0}});
 if(!village)low.split(/[^a-z]+/).filter(w=>w.length>3).forEach(w=>vs.forEach(v=>{const d=lev(w,v.name.toLowerCase());if(d<best&&d<=2){best=d;village=v}}));
 const clauses=raw.split(/,|;|\.|\band\b|மற்றும்|और|এবং/i).map(s=>s.trim()).filter(Boolean),entries=[];
 clauses.forEach(c=>{const cl=c.toLowerCase();let n=null;const dm=cl.match(/\d+/);if(dm)n=+dm[0];else for(const w of cl.split(/\s+/)){const k=w.replace(/[^\p{L}\p{M}]/gu,'');if(NUMW[k]){n=NUMW[k];break}}
  for(const[sym,words]of Object.entries(LEX))if(words.some(w=>cl.includes(w.toLowerCase())))entries.push({symptom:sym,count:n??1,guess:n==null});});
 const merged={};entries.forEach(e=>{merged[e.symptom]=merged[e.symptom]?{...merged[e.symptom],count:merged[e.symptom].count+e.count}:e});
 return{village,confidence:village?(best===0?'exact':'fuzzy'):'none',entries:Object.values(merged),raw};
}
const SYM2SYN={fever:'fever',vomiting:'diarrhea',diarrhea:'diarrhea',cough:'respiratory',breath:'respiratory'};

/* ---- Medicine verification: structured code + integrity checksum + trusted registry ---- */
function verifyMed(code){
 const c=code.trim().toUpperCase(),m=c.match(/^MM-([A-Z]{3})-([A-Z0-9]{4})-(\d{2})$/);
 if(!m)return{state:'unverified',msg:'Medicine information could not be verified.',why:'Code format not recognised. Enter the code printed near the batch number, or scan a supported QR.'};
 const good=batchCode(m[1],m[2]);
 if(good!==c)return{state:'unverified',msg:'Medicine information could not be verified.',why:'The code failed its integrity check — it may be mistyped or altered. Do not rely on this package until checked by a pharmacist.'};
 const r=DB.registry[c];if(!r)return{state:'unverified',msg:'Medicine information could not be verified.',why:'Code is well-formed but not present in the trusted registry available to this device.'};
 const med=medById(r.med);
 if(r.recalled)return{state:'recalled',msg:'Recall notice — do not use.',med,batch:r.batch,exp:r.exp,why:'This batch has been recalled. Return it to the pharmacist.'};
 if(r.exp<Date.now())return{state:'expired',msg:'Expired batch — do not use.',med,batch:r.batch,exp:r.exp,why:'The registry lists this batch as past its expiry date.'};
 return{state:'verified',msg:'Verified against the trusted registry.',med,batch:r.batch,exp:r.exp,why:'Batch and expiry match registry records.'};
}

/* ---- Rule-based triage (clinician-reviewed rule set v1) — screening support, never a diagnosis ---- */
function triage(list,durDays,person){
 const red=list.filter(s=>SYM.find(x=>x.k===s.k)?.red);let score=sum(list.map(s=>(SYM.find(x=>x.k===s.k)?.w||1)*s.sev));
 score+=durDays>=3?1.5:0;if(person&&(person.age<5||person.age>65)&&list.some(s=>s.k==='fever'))score+=1.5;score=Math.round(score*10)/10;
 const level=red.length||score>=9?'high':score>=5?'medium':'low';
 const flags=[];red.forEach(s=>flags.push(symL(s.k)+' is a red-flag symptom'));if(durDays>=3)flags.push('Symptoms lasting 3+ days');if(person&&(person.age<5||person.age>65))flags.push('Age group needs earlier review');
 const advice=level==='high'?'Seek in-person clinical review today. If breathing is difficult or the person is confused, use Emergency Help.':level==='medium'?'Your ASHA worker will review this within 24 hours. Keep hydrated and rest.':'Monitor at home. Your ASHA worker will check in. Report any worsening.';
 return{score,level,flags,advice};
}
const trendLabel=(t)=>{const l=t[t.length-1],p=t.length>2?t[t.length-3]:t[0];const lvl=l>=7?'high':l>=4?'medium':'low';return{lvl,label:l<p-1?'Improving':l>p+1?'Worsening':'Stable',score:l}};
function patientAI(p){
 const s=p.symptoms[p.symptoms.length-1],tr=trendLabel(p.trend);
 if(!s)return{text:'No active symptoms recorded.',level:'low'};
 const names=s.list.map(x=>symL(x.k).toLowerCase()).join(' and '),tri=triage(s.list,parseInt(s.dur)||1,p);
 const level=p.riskConfirmed?p.riskConfirmed.level:tr.lvl;return{text:`${cap(names)} for ${s.dur}. Trend: ${tr.label.toLowerCase()}. Current screening level: ${level}.${p.allergies.length?' Allergy on file: '+p.allergies.join(', ')+'.':''}`,level,tri};
}

/* ================= RBAC API (server-side simulation) ================= */
class ApiErr extends Error{constructor(status,msg){super(msg);this.status=status}}
const need=(c,m,s=422)=>{if(!c)throw new ApiErr(s,m)};
let auditLock=Promise.resolve();
function audit(user,action,target,ok=true){
 auditLock=auditLock.then(async()=>{const prev=DB.audit.length?DB.audit[DB.audit.length-1].hash:DB.auditBase,e={id:uid('a'),t:Date.now(),uid:user?.id||'-',who:user?.name||'anonymous',role:user?.role||'-',action,target:target||'',ok,prev};
  e.hash=await sha256([prev,e.t,e.uid,e.action,e.target,e.ok].join('|'));DB.audit.push(e);if(DB.audit.length>500){DB.auditBase=DB.audit[99].hash;DB.audit.splice(0,100)}save()});return auditLock;
}
async function verifyChain(){let prev=DB.auditBase,bad=null;for(const e of DB.audit){const h=await sha256([prev,e.t,e.uid,e.action,e.target,e.ok].join('|'));if(e.prev!==prev||e.hash!==h){bad=e;break}prev=e.hash}return{ok:!bad,bad,n:DB.audit.length}}
function pushSync(desc){DB.sync.unshift({id:uid('sy'),t:Date.now(),desc,status:NET.online?'synced':'waiting'});if(DB.sync.length>60)DB.sync.pop()}
const NET={online:true};
async function flushSync(){const q=DB.sync.filter(s=>s.status==='waiting').reverse();for(const s of q){await sleep(350);s.status='synced';s.tS=Date.now();save();UI.sync()}if(q.length)await audit(curUser(),`Secure sync completed (${q.length} records)`,'sync_queue');return q.length}
function curUser(){const s=DB?.sessions[sess.get()];return s?DB.users.find(u=>u.id===s.uid):null}
const IDLE=30*MIN;
const EP={};
const ep=(name,roles,fn,o={})=>EP[name]={roles,fn,...o};
const uOf=pid=>DB.users.find(u=>u.pid===pid);
const ptGet=id=>{const p=DB.patients.find(x=>x.id===id);need(p,'Patient not found',404);return p};
function canSee(u,p){
 if(u.role==='patient')return p.id===u.pid;
 if(u.role==='asha')return u.villages.includes(p.village);
 if(u.role==='doctor')return p.doctorId===u.id||DB.referrals.some(r=>r.pid===p.id&&['clinician-confirmed','accepted'].includes(r.status)&&facBy(r.facId)?.id===u.fac);
 return false;
}
function consentOK(u,p){if(u.role==='doctor')return p.consent.doctor;if(u.role==='asha')return p.consent.asha;return true}
function shape(u,p){
 const base={id:p.id,name:p.name,age:p.age,gender:p.gender,village:p.village,queue:p.queue,color:p.color};
 if(!canSee(u,p))throw new ApiErr(403,'Forbidden: this record is outside your assignment');
 if(!consentOK(u,p))return{...base,restricted:true,name:p.name.split(' ')[0]+' •••'};
 return{...p,ai:patientAI(p),trendInfo:trendLabel(p.trend),rxs:DB.rxs.filter(r=>r.pid===p.id),doses:DB.doses.filter(d=>d.pid===p.id).sort((a,b)=>a.due-b.due),refs:DB.referrals.filter(r=>r.pid===p.id)};
}
const TIMES={'Once a day':['08:00'],'Twice a day':['08:00','20:00'],'Three times a day':['08:00','14:00','20:00'],'Four times a day':['06:00','12:00','18:00','22:00'],'At bedtime':['21:30']};
function addTL(p,ev,by){p.timeline.push({t:Date.now(),ev,by})}
function missStreak(pid){const ds=DB.doses.filter(d=>d.pid===pid&&d.status!=='pending'&&d.status!=='snoozed').sort((a,b)=>a.due-b.due);let n=0;for(let i=ds.length-1;i>=0&&ds[i].status==='missed';i--)n++;return n}
function adherence(pid){const ds=DB.doses.filter(d=>d.pid===pid&&d.status!=='pending'&&d.status!=='snoozed');return ds.length?Math.round(ds.filter(d=>d.status==='taken').length/ds.length*100):100}

/* common */
ep('notif.list',Object.keys(ROLES),(c)=>DB.notifs.filter(n=>n.to==='role:'+c.user.role||n.to==='user:'+c.user.id).sort((a,b)=>b.t-a.t).slice(0,40));
ep('notif.read',Object.keys(ROLES),(c)=>{DB.notifs.forEach(n=>{if(n.to==='role:'+c.user.role||n.to==='user:'+c.user.id)n.read=true})},{w:1});
ep('sync.list',Object.keys(ROLES),()=>DB.sync.slice(0,25));
ep('sync.flush',Object.keys(ROLES),async()=>flushSync());
ep('fac.list',['hospital','doctor','asha','officer','ambulance','pharmacist'],()=>DB.facilities);
ep('med.verify',['patient','pharmacist','asha','hospital'],(c,a)=>verifyMed(a.code||''),{audit:(a,r)=>`Medicine verification: ${r.state}`});
ep('opt.run',['officer','asha','doctor','hospital'],(c,a)=>{need(vBy(a.v)&&SERVICES.includes(a.service),'Choose a village and service');return optimize(a)});
ep('geo.metrics',['officer','asha'],(c)=>geoMetrics(c.user));
ep('geo.radar',['officer','asha'],(c,a)=>{need(c.user.role!=='asha'||c.user.villages.includes(a.v),'Village outside your assignment',403);return SYN.map(s=>radarSyn(a.v,s))});
ep('alert.list',['officer','asha'],(c)=>DB.alerts.filter(a=>c.user.role==='officer'||c.user.villages.includes(a.v)).sort((a,b)=>b.t-a.t));
/* patient */
ep('pt.me',['patient'],(c)=>({...shape(c.user,ptGet(c.user.pid)),sos:DB.sos.filter(e=>e.pid===c.user.pid).sort((a,b)=>b.t-a.t)}));
ep('pt.report',['patient'],(c,a)=>{const p=ptGet(c.user.pid);need(a.list?.length,'Select at least one symptom');need(a.dur>=1&&a.dur<=60,'Enter how many days (1–60)');const tri=triage(a.list,a.dur,p);
 const s={id:uid('s'),t:Date.now(),list:a.list,dur:a.dur+(a.dur===1?' day':' days'),src:'patient',verified:'asha-review',tri};p.symptoms.push(s);p.trend.push(tri.score);addTL(p,'Symptoms reported','Patient');
 ashaFor(p.village).forEach(u=>{addTask({ashaId:u.id,type:'verify',pid:p.id,text:`Review new symptom report from ${p.name}`,priority:tri.level==='high'?'high':'medium'});notify('user:'+u.id,`${p.name} reported symptoms (${tri.level} screening level).`,'user')});return{tri,s}},{w:1,audit:(a)=>'Patient reported symptoms',
});
ep('pt.dose',['patient'],(c,a)=>{const d=DB.doses.find(x=>x.id===a.id&&x.pid===c.user.pid);need(d,'Dose not found',404);need(['taken','missed','snoozed'].includes(a.status),'Invalid status');d.status=a.status;d.ts=Date.now();if(a.status==='snoozed')d.due=Math.max(d.due,Date.now())+ (a.mins||15)*MIN;
 const p=ptGet(c.user.pid);let esc=null;if(a.status==='missed'){const n=missStreak(p.id);if(n>=2){notify('user:'+c.user.id,`You have missed ${n} doses in a row. Please take your next dose as prescribed, or contact your ASHA worker.`,'pill');esc='patient'}
  if(n>=3&&p.consent.adherenceToAsha){notify('role:asha',`Repeated missed doses: ${p.name}. Follow-up suggested.`,'pill');ashaFor(p.village).forEach(u=>addTask({ashaId:u.id,type:'missed-med',pid:p.id,text:`Missed-medication follow-up for ${p.name}`,priority:'high'}));esc='asha'}}
 return{adherence:adherence(p.id),streak:missStreak(p.id),esc}},{w:1,audit:(a)=>'Patient updated dose status ('+a.status+')'});
ep('pt.confirm',['patient'],(c,a)=>{const p=ptGet(c.user.pid),s=p.symptoms.find(x=>x.id===a.sid);need(s,'Record not found',404);need(s.verified==='pending','This record is not awaiting your confirmation');
 if(a.action==='correct'){need(a.list?.length,'Select at least one symptom');s.list=a.list;if(a.dur)s.dur=a.dur+' days';s.verified='corrected'}else s.verified='confirmed';
 addTL(p,'Patient confirmed information','Patient');if(!p.queue)p.queue='waiting';notify('role:doctor',`${p.name} confirmed their record and joined the queue.`,'users');return s},{w:1,audit:(a)=>'Patient '+(a.action==='correct'?'corrected':'confirmed')+' information'});
ep('pt.consent',['patient'],(c,a)=>{const p=ptGet(c.user.pid);need(['doctor','asha','analytics','adherenceToAsha'].includes(a.key),'Unknown consent');p.consent[a.key]=!!a.val;return p.consent},{w:1,audit:(a)=>`Patient ${a.val?'granted':'withdrew'} consent: ${a.key}`});
ep('pt.profile',['patient'],(c,a)=>{const p=ptGet(c.user.pid);if(a.organ!=null){need(['Registered donor','Not registered','Interested in donation','Do not wish to donate','Unknown'].includes(a.organ),'Invalid option');p.organ=a.organ}
 if(a.emName!=null){need(a.emName.trim().length>1&&/^\d{10}$/.test(a.emPhone),'Enter a name and a 10-digit phone number');p.emergency={name:a.emName.trim(),phone:a.emPhone,rel:a.emRel||'Family'}}return p},{w:1,audit:(a)=>a.organ?'Patient updated organ donation preference':'Patient updated emergency contact'});
ep('pt.sos',['patient'],(c,a)=>{const p=ptGet(c.user.pid),v=vBy(p.village),e={id:uid('e'),pid:p.id,who:p.name,village:p.village,lat:v.lat,lon:v.lon,t:Date.now(),status:'requested',ambId:null,eta:null,facId:null,note:a.note||'Patient-initiated emergency'};DB.sos.unshift(e);
 notify('role:ambulance',`EMERGENCY request from ${v.name} — assign nearest ambulance.`,'alert');notify('role:hospital',`Possible incoming emergency from ${v.name}.`,'alert');notify('user:'+p.ashaId,`${p.name} requested emergency help.`,'alert');return e},{w:1,audit:()=>'Patient started emergency workflow'});
/* asha */
ep('ah.tasks',['asha'],(c)=>DB.tasks.filter(t=>t.ashaId===c.user.id).sort((a,b)=>(a.done-b.done)||(({high:0,medium:1,low:2})[a.priority]-({high:0,medium:1,low:2})[b.priority])));
ep('task.done',['asha'],(c,a)=>{const t=DB.tasks.find(x=>x.id===a.id&&x.ashaId===c.user.id);need(t,'Task not found',404);t.done=true;return t},{w:1,audit:(a)=>'ASHA completed a task'});
ep('pt.list',['asha','doctor'],(c)=>DB.patients.filter(p=>canSee(c.user,p)).map(p=>{const s=shape(c.user,p);return s}));
ep('pt.get',['asha','doctor'],(c,a)=>shape(c.user,ptGet(a.id)),{audit:(a,r)=>`${cap(curRole())} viewed patient record`,target:(a)=>a.id});
ep('ah.register',['asha'],(c,a)=>{need(a.name?.trim().length>2,'Enter the patient\'s full name');need(a.age>=0&&a.age<=110,'Enter a valid age');need(/^\d{10}$/.test(a.phone),'Phone must be 10 digits');need(c.user.villages.includes(a.village),'Village is outside your assignment',403);need(a.consent,'Patient consent is required to register');
 const p={id:uid('p'),name:a.name.trim(),age:+a.age,gender:a.gender,phone:a.phone,address:a.address||'—',village:a.village,district:'Cuddalore',state:'Tamil Nadu',blood:a.blood||'Unknown',organ:'Unknown',allergies:a.allergies?a.allergies.split(',').map(s=>s.trim()).filter(Boolean):[],conditions:[],emergency:{name:'Not set',phone:'—',rel:'—'},consent:{doctor:true,asha:true,analytics:true,adherenceToAsha:true},ashaId:c.user.id,doctorId:DB.users.find(u=>u.role==='doctor'&&u.active)?.id,queue:null,symptoms:[],trend:[2],notes:[],timeline:[{t:Date.now(),ev:'Registered by ASHA',by:c.user.name}],rx:[],followup:null,guidance:[],color:'#0A6E8A',meds:[],riskConfirmed:null};DB.patients.push(p);return p},{w:1,audit:()=>'ASHA registered a patient'});
ep('ah.symptom',['asha'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p),'Outside assignment',403);need(a.list?.length,'Select at least one symptom');need(a.dur>=1&&a.dur<=60,'Enter days (1–60)');const tri=triage(a.list,a.dur,p);
 const s={id:uid('s'),t:Date.now(),list:a.list,dur:a.dur+(a.dur===1?' day':' days'),src:a.src||'asha',verified:'pending',tri};p.symptoms.push(s);p.trend.push(tri.score);addTL(p,'Symptoms recorded by ASHA',c.user.name);const pu=uOf(p.id);if(pu)notify('user:'+pu.id,`Your recorded information is: ${a.list.map(x=>symL(x.k).toLowerCase()).join(' and ')} for ${s.dur}. Please confirm.`,'check');return{s,tri}},{w:1,audit:()=>'ASHA updated symptom record'});
ep('ah.verify',['asha'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p),'Outside assignment',403);const s=p.symptoms.find(x=>x.id===a.sid);need(s,'Record not found',404);need(['asha-review','pending'].includes(s.verified),'Already verified');s.verified='pending';addTL(p,'ASHA reviewed',c.user.name);
 const pu=uOf(p.id);if(pu)notify('user:'+pu.id,`Your recorded information is: ${s.list.map(x=>symL(x.k).toLowerCase()).join(' and ')} for ${s.dur}. Please confirm.`,'check');DB.tasks.filter(t=>t.pid===p.id&&t.type==='verify'&&t.ashaId===c.user.id).forEach(t=>t.done=true);return s},{w:1,audit:()=>'ASHA verified record and sent it to patient'});
ep('ah.note',['asha','doctor'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p),'Outside assignment',403);need(a.text?.trim(),'Write a note first');p.notes.push({t:Date.now(),by:c.user.name+(c.user.role==='asha'?' (ASHA)':''),text:a.text.trim()});return p},{w:1,audit:(a)=>'Field/clinical note added'});
ep('ah.voice',['asha'],(c,a)=>{need(c.user.villages.includes(a.v),'Village outside your assignment',403);need(a.entries?.length,'No structured entries to save');
 a.entries.forEach(e=>{const syn=SYM2SYN[e.symptom];if(!syn)return;const arr=DB.signals[a.v][syn].asha;arr[arr.length-1]+=Math.max(0,Math.min(200,+e.count||0))});DB.voice=DB.voice||[];DB.voice.unshift({id:uid('vr'),t:Date.now(),uid:c.user.id,v:a.v,raw:a.raw,entries:a.entries});refreshAlerts(false);return radarSyn(a.v,'fever')},{w:1,audit:()=>'ASHA saved a voice report'});
/* doctor */
ep('dr.rx',['doctor'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p)&&consentOK(c.user,p),'No access to this patient',403);need(a.items?.length,'Add at least one medicine');const items=[];
 for(const i of a.items){const m=medById(i.med);need(m,'Choose a medicine');need(i.dose?.trim()&&TIMES[i.freq]&&i.days>=1&&i.days<=90,`Check dosage, frequency and duration (1–90 days) for ${m.name}`);
  if(m.cls&&p.allergies.some(x=>x.toLowerCase().startsWith(m.cls)))throw new ApiErr(409,`Allergy conflict: ${m.name} is ${m.cls}-class and ${p.name} has a recorded ${m.cls} allergy. Choose an alternative.`);
  items.push({med:m.name,dose:i.dose.trim(),freq:i.freq,days:+i.days,instr:i.instr||'As directed',times:TIMES[i.freq],start:Date.now(),end:Date.now()+i.days*DAY})}
 const r={id:uid('rx'),pid:p.id,doctorId:c.user.id,t:Date.now(),status:'issued',pharm:'pending',items};DB.rxs.push(r);p.rx.push(r.id);
 items.forEach(it=>{for(let d=0;d<Math.min(it.days,3);d++)it.times.forEach(tm=>{const[h,m]=tm.split(':').map(Number),x=new Date(it.start+d*DAY);x.setHours(h,m,0,0);if(x.getTime()>Date.now())DB.doses.push({id:uid('d'),pid:p.id,rxId:r.id,med:it.med,dose:it.dose,due:x.getTime(),status:'pending',ts:null})})});
 addTL(p,'Prescription issued',c.user.name);p.queue='seen';const pu=uOf(p.id);if(pu)notify('user:'+pu.id,'A new prescription was approved by '+c.user.name+'. Reminders are set from your doctor\'s instructions.','pill');notify('role:pharmacist',`New prescription for ${p.name} awaiting verification.`,'file');return r},{w:1,audit:()=>'Doctor created prescription'});
ep('dr.note',['doctor'],(c,a)=>EP['ah.note'].fn(c,a),{w:1,audit:()=>'Doctor added clinical note'});
ep('dr.guide',['doctor'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p),'No access',403);need(a.text?.trim().length>4,'Write the guidance text');p.guidance.push({id:uid('g'),text:a.text.trim(),status:'approved',by:c.user.name});return p},{w:1,audit:()=>'Doctor approved health guidance'});
ep('dr.follow',['doctor'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p),'No access',403);need(a.date&&new Date(a.date)>new Date(Date.now()-DAY),'Pick a future date');p.followup=new Date(a.date+'T10:00').getTime();addTL(p,'Follow-up scheduled',c.user.name);return p},{w:1,audit:()=>'Doctor scheduled follow-up'});
ep('dr.risk',['doctor'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p),'No access',403);need(['low','medium','high'].includes(a.level),'Choose a risk level');p.riskConfirmed={level:a.level,by:c.user.name,t:Date.now()};p.trend.push(a.level==='high'?8:a.level==='medium'?5:2);addTL(p,'Risk status confirmed: '+a.level,c.user.name);return p},{w:1,audit:()=>'Doctor confirmed risk status'});
ep('dr.seen',['doctor'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p),'No access',403);p.queue='seen';addTL(p,'Doctor consultation',c.user.name);return p},{w:1,audit:()=>'Doctor completed consultation'});
/* referrals */
ep('ref.suggest',['asha','doctor'],(c,a)=>{const p=ptGet(a.pid);need(canSee(c.user,p),'No access',403);need(a.facId&&facBy(a.facId)&&SERVICES.includes(a.service),'Choose a facility and service');const doc=c.user.role==='doctor';
 const r={id:uid('r'),pid:p.id,from:c.user.id,village:p.village,service:a.service,urgency:a.urgency||'urgent',facId:a.facId,status:doc?'clinician-confirmed':'suggested',t:Date.now(),note:a.note||''};DB.referrals.unshift(r);addTL(p,doc?'Referral recommended by clinician':'Referral suggested by ASHA',c.user.name);
 if(doc)notify('role:hospital',`Clinician-confirmed referral: ${p.name} → ${SVC_L[a.service]}.`,'building');else notify('role:doctor',`Referral suggestion for ${p.name} awaits clinical confirmation.`,'stetho');return r},{w:1,audit:(a)=>'Referral suggested'});
ep('ref.list',['doctor','hospital','asha'],(c)=>DB.referrals.filter(r=>{const p=ptGet(r.pid);return c.user.role==='hospital'?r.facId===c.user.fac:canSee(c.user,p)}).map(r=>{const p=ptGet(r.pid);return{...r,pname:c.user.role==='hospital'||consentOK(c.user,p)?p.name:'Restricted',age:p.age,village:p.village}}));
ep('ref.decide',['doctor'],(c,a)=>{const r=DB.referrals.find(x=>x.id===a.id);need(r,'Not found',404);need(canSee(c.user,ptGet(r.pid)),'No access',403);need(r.status==='suggested','Already decided');r.status=a.action==='confirm'?'clinician-confirmed':'declined';if(r.status==='clinician-confirmed')notify('role:hospital',`Clinician-confirmed referral: ${ptGet(r.pid).name} → ${SVC_L[r.service]}.`,'building');return r},{w:1,audit:(a)=>'Doctor '+(a.action==='confirm'?'confirmed':'declined')+' referral'});
ep('ref.accept',['hospital'],(c,a)=>{const r=DB.referrals.find(x=>x.id===a.id);need(r&&r.facId===c.user.fac,'Referral not addressed to your facility',403);need(r.status==='clinician-confirmed'||r.status==='accepted','Requires clinician confirmation before the facility can act',409);const f=facBy(c.user.fac);
 if(a.action==='accept')r.status='accepted';else if(a.action==='decline')r.status='declined';else if(a.action==='admit'){need(f.beds.free>0,'No free beds — update capacity or decline',409);f.beds.free--;r.status='completed'}return r},{w:1,audit:(a)=>'Facility '+a.action+' referral'});
/* pharmacy */
ep('rx.list',['pharmacist'],()=>DB.rxs.map(r=>{const p=ptGet(r.pid);return{id:r.id,t:r.t,pharm:r.pharm,items:r.items,patient:{name:p.name,age:p.age,allergies:p.allergies,village:p.village},doctor:DB.users.find(u=>u.id===r.doctorId)?.name}}).sort((a,b)=>b.t-a.t));
ep('rx.act',['pharmacist'],(c,a)=>{const r=DB.rxs.find(x=>x.id===a.id);need(r,'Not found',404);const p=ptGet(r.pid);
 if(a.action==='verify'){need(r.pharm==='pending','Already processed');r.pharm='verified';return r}
 if(a.action==='reject'){need(a.reason?.trim(),'Give a reason for rejection');r.pharm='rejected';notify('role:doctor','Pharmacist rejected a prescription: '+a.reason,'alert');return r}
 need(r.pharm==='verified','Verify the prescription first',409);const inv=DB.inventory[p.village];
 for(const it of r.items){const m=MED.find(x=>x.name===it.med);if(!m)continue;const n=it.times.length*it.days;need(inv[m.id].qty>=n,`Insufficient ${m.name} in ${vName(p.village)} (${inv[m.id].qty} left, ${n} needed). See MedShare Village.`,409)}
 r.items.forEach(it=>{const m=MED.find(x=>x.name===it.med);if(m)inv[m.id].qty-=it.times.length*it.days});r.pharm='dispensed';const pu=uOf(p.id);if(pu)notify('user:'+pu.id,'Your medicines were dispensed by the pharmacy.','pill');refreshAlerts(false);return r},{w:1,audit:(a)=>'Pharmacist '+a.action+' prescription'});
ep('inv.list',['pharmacist'],()=>DB.inventory);
ep('inv.update',['pharmacist'],(c,a)=>{const e=DB.inventory[a.v]?.[a.med];need(e,'Unknown item',404);if(a.delta!=null){need(Number.isFinite(+a.delta),'Enter a number');e.qty=Math.max(0,e.qty+ +a.delta)}else{need(a.qty>=0,'Quantity must be 0 or more');e.qty=+a.qty}return e},{w:1,audit:(a)=>'Pharmacist updated medicine stock'});
function medSharePlan(){const out=[];MED.forEach(m=>{const need_=[],spare=[];DB.villages.forEach(v=>{const e=DB.inventory[v.id][m.id],cv=e.qty/e.demand;if(cv<5)need_.push({v,n:Math.ceil(e.demand*10-e.qty),cv});else if(cv>21)spare.push({v,n:Math.floor(e.qty-e.demand*14),cv})});
 need_.sort((a,b)=>a.cv-b.cv).forEach(nd=>{spare.sort((a,b)=>hav(a.v,nd.v)-hav(b.v,nd.v));for(const sp of spare){if(nd.n<=0)break;const q=Math.min(nd.n,sp.n);if(q<=0)continue;out.push({med:m.id,from:sp.v.id,to:nd.v.id,qty:q,km:Math.round(hav(sp.v,nd.v)*1.3),toCover:nd.cv});nd.n-=q;sp.n-=q}})});return out}
ep('ms.plan',['pharmacist'],()=>medSharePlan());
ep('ms.exec',['pharmacist'],(c,a)=>{const s=DB.inventory[a.from]?.[a.med],d=DB.inventory[a.to]?.[a.med];need(s&&d&&a.qty>0&&s.qty>=a.qty,'Transfer is no longer possible',409);s.qty-=a.qty;d.qty+=a.qty;refreshAlerts(false);return{ok:1}},{w:1,audit:(a)=>`MedShare transfer approved (${medById(a.med).name})`});
/* hospital */
ep('fac.get',['hospital'],(c)=>facBy(c.user.fac));
ep('fac.update',['hospital'],(c,a)=>{const f=facBy(c.user.fac);if(a.svc){need(SERVICES.includes(a.svc)&&['available','limited','unavailable'].includes(a.state),'Invalid service state');f.services[a.svc]=a.state}
 if(a.beds!=null){need(a.beds>=0&&a.beds<=f.beds.total,'Beds must be between 0 and '+f.beds.total);f.beds.free=+a.beds}if(a.doctors!=null){need(a.doctors>=0&&a.doctors<=f.doctors.total,'Doctors on duty must be 0–'+f.doctors.total);f.doctors.on=+a.doctors}if(a.er!=null){need(a.er>=0&&a.er<=f.er.total,'Emergency bays must be 0–'+f.er.total);f.er.free=+a.er}return f},{w:1,audit:()=>'Facility updated capacity/services'});
/* ambulance */
ep('amb.list',['ambulance','hospital','officer'],()=>DB.ambulances);
ep('sos.list',['ambulance','hospital','officer'],(c)=>DB.sos.map(e=>({...e,who:c.user.role==='ambulance'?e.who:'Withheld (privacy)'})));
ep('sos.assign',['ambulance'],(c,a)=>{const e=DB.sos.find(x=>x.id===a.id),am=DB.ambulances.find(x=>x.id===a.ambId);need(e&&am,'Not found',404);need(e.status==='requested','Already assigned',409);need(am.status==='available','Ambulance is not available',409);need(facBy(a.facId),'Choose a destination');
 e.ambId=am.id;e.facId=a.facId;e.status='dispatched';e.eta=Math.round(hav(am,e)*1.3/45*60+3);am.status='dispatched';am.caseId=e.id;notify('role:hospital',`Ambulance ${am.id} dispatched to ${vName(e.village)} → ${facBy(a.facId).short}.`,'truck');const pu=e.pid&&uOf(e.pid);if(pu)notify('user:'+pu.id,`Ambulance ${am.id} is on the way. ETA ${e.eta} min.`,'truck');return e},{w:1,audit:()=>'Ambulance dispatched'});
ep('sos.step',['ambulance'],(c,a)=>{const e=DB.sos.find(x=>x.id===a.id);need(e&&e.ambId,'Assign an ambulance first',409);const seq=['dispatched','enroute','onscene','transporting','completed'],i=seq.indexOf(e.status);need(i>=0&&i<4,'Case already completed',409);e.status=seq[i+1];const am=DB.ambulances.find(x=>x.id===e.ambId),f=facBy(e.facId);
 if(e.status==='enroute')am.status='enroute';if(e.status==='onscene'){am.status='onscene';am.lat=e.lat;am.lon=e.lon;e.eta=0}if(e.status==='transporting'){am.status='transporting';e.eta=Math.round(hav(e,f)*1.3/45*60)}
 if(e.status==='completed'){am.status='available';am.caseId=null;am.lat=f.lat;am.lon=f.lon;e.eta=null;notify('role:hospital',`Patient delivered to ${f.short} by ${am.id}.`,'building')}return e},{w:1,audit:(a)=>'Ambulance case advanced'});
ep('amb.set',['ambulance'],(c,a)=>{const am=DB.ambulances.find(x=>x.id===a.id);need(am,'Not found',404);need(!am.caseId,'Vehicle is assigned to a live case',409);need(['available','maintenance'].includes(a.status),'Invalid status');am.status=a.status;return am},{w:1,audit:(a)=>'Ambulance status changed to '+a.status});
/* officer */
ep('alert.act',['officer'],(c,a)=>{const al=DB.alerts.find(x=>x.id===a.id);need(al,'Not found',404);if(a.action==='ack')al.status='ack';else if(a.action==='assign'){const u=DB.users.find(x=>x.id===a.ashaId&&x.role==='asha');need(u,'Choose an ASHA worker');al.status='assigned';al.assigned=u.id;addTask({ashaId:u.id,type:'signal',village:al.v,text:`Verify ${al.syn} signal in ${vName(al.v)} (assigned by officer)`,priority:'high'});notify('user:'+u.id,`Officer assigned you to verify a ${al.syn} signal in ${vName(al.v)}.`,'radar')}else if(a.action==='close')al.status='resolved';return al},{w:1,audit:(a)=>'Officer '+a.action+' alert'});
ep('sim.inject',['officer'],(c,a)=>{need(vBy(a.v)&&SYN.includes(a.syn)&&a.k>=1&&a.k<=6,'Choose village, syndrome and multiplier (1–6)');const R=rng(Date.now()%9999);SRC.forEach(src=>{const arr=DB.signals[a.v][a.syn][src],b=median(arr.slice(0,9));for(let i=9;i<14;i++)arr[i]=Math.max(0,Math.round(b*(1+(a.k-1)*Math.min(1,(i-8)/3))+(R()-.5)*Math.max(1,b*.3)))});refreshAlerts(false);return radarSyn(a.v,a.syn)},{w:1,audit:(a)=>`Officer injected simulated ${a.syn} surge`});
ep('sim.reset',['officer','admin'],()=>{const keep=DB.users,fresh=seed();DB.signals=fresh.signals;DB.alerts=[];refreshAlerts(true);return 1},{w:1,audit:()=>'Signals reset to baseline scenario'});
ep('fed.round',['officer'],(c,a)=>fedRound(clamp(+a.eps||2,.5,5),a.seed||1),{audit:()=>'Federated aggregation round executed'});
ep('loop.state',['officer'],()=>({sigDone:DB.tasks.filter(t=>t.type==='signal'&&t.done).length,seen:DB.patients.filter(p=>p.queue==='seen').length,rxTotal:DB.rxs.length,pendingDoses:DB.doses.filter(d=>d.status==='pending').length,guidance:DB.patients.reduce((n,p)=>n+p.guidance.length,0),alerts:DB.alerts.filter(a=>a.status!=='resolved').length,tasks:DB.tasks.filter(t=>t.type==='signal'&&!t.done).length,pendingVerify:DB.patients.filter(p=>p.symptoms.some(s=>['pending','asha-review'].includes(s.verified))).length,waiting:DB.patients.filter(p=>p.queue==='waiting').length,rx:DB.rxs.filter(r=>r.pharm==='pending').length,doses:DB.doses.filter(d=>d.status==='taken').length,fu:DB.patients.filter(p=>p.followup).length}));
ep('ah.voices',['asha'],(c)=>(DB.voice||[]).filter(v=>c.user.villages.includes(v.v)));
ep('inv.demand',['pharmacist'],()=>Object.fromEntries(DB.villages.map(v=>[v.id,Object.fromEntries(SYN.map(s=>[s,DB.signals[v.id][s].pharmacy]))])));
ep('adm.reseal',['admin'],async()=>{let prev=DB.auditBase;for(const e of DB.audit){e.prev=prev;e.hash=await sha256([prev,e.t,e.uid,e.action,e.target,e.ok].join('|'));prev=e.hash}return 1},{w:1,audit:()=>'Audit chain re-sealed by administrator'});
/* admin */
ep('adm.users',['admin'],()=>DB.users.map(u=>({id:u.id,name:u.name,email:u.email,role:u.role,active:u.active})));
ep('adm.user',['admin'],(c,a)=>{const u=DB.users.find(x=>x.id===a.id);need(u,'Not found',404);need(u.id!==c.user.id,'You cannot change your own access',409);if(a.role){need(ROLES[a.role],'Unknown role');u.role=a.role}
 if(a.active!=null){if(!a.active)need(DB.users.filter(x=>x.role==='admin'&&x.active&&x.id!==u.id).length||u.role!=='admin','At least one active administrator is required',409);u.active=!!a.active;if(!u.active)Object.keys(DB.sessions).forEach(k=>{if(DB.sessions[k].uid===u.id)delete DB.sessions[k]})}return u},{w:1,audit:(a)=>'Admin changed authorization ('+(a.role?'role → '+a.role:a.active?'enabled':'disabled')+')'});
ep('adm.audit',['admin'],()=>[...DB.audit].reverse());
ep('adm.verify',['admin'],async()=>verifyChain());
ep('adm.stats',['admin'],()=>({users:DB.users.length,audit:DB.audit.length,denied:DB.audit.filter(a=>!a.ok).length,sessions:Object.keys(DB.sessions).length,queued:DB.sync.filter(s=>s.status==='waiting').length,consent:{doctor:DB.patients.filter(p=>p.consent.doctor).length,analytics:DB.patients.filter(p=>p.consent.analytics).length,n:DB.patients.length}}));
ep('adm.tamper',['admin'],()=>{const e=DB.audit[Math.max(0,DB.audit.length-3)];if(e)e.action=e.action+' [EDITED]';return 1},{w:1});
let _curRole='';const curRole=()=>_curRole;
async function api(name,args={}){
 await sleep(50+Math.random()*70);
 const e=EP[name];if(!e)throw new ApiErr(404,'Unknown endpoint');
 const s=DB.sessions[sess.get()];if(!s||Date.now()-s.last>IDLE){throw new ApiErr(401,'Session expired — please sign in again')}
 const user=DB.users.find(u=>u.id===s.uid);if(!user||!user.active){throw new ApiErr(401,'Account disabled')}
 _curRole=user.role;
 if(!e.roles.includes(user.role)){await audit(user,`DENIED ${name}`,'',false);throw new ApiErr(403,`Access denied: the ${ROLES[user.role].label} role cannot use ${name}`)}
 s.last=Date.now();const r=await e.fn({user},args);
 if(e.audit)await audit(user,typeof e.audit==='function'?e.audit(args,r):e.audit,e.target?e.target(args):(args.pid||args.id||''));
 if(e.w){pushSync(name.replace('.',' → '));save()}return r;
}
function probe(role,name){const e=EP[name];return e?e.roles.includes(role):null}
/* auth */
const auth={
 async login(email,pw){email=(email||'').trim().toLowerCase();const L=DB.locks[email]||{n:0,until:0};
  if(L.until>Date.now()){await audit(null,'Login blocked (rate limit)',email,false);throw new ApiErr(429,`Too many attempts. Try again in ${Math.ceil((L.until-Date.now())/1000)} s.`)}
  const u=DB.users.find(x=>x.email===email);const ok=u&&u.active&&(await sha256(u.salt+pw))===u.hash;
  if(!ok){L.n++;if(L.n>=5){L.until=Date.now()+60000;L.n=0}DB.locks[email]=L;await audit(u||null,'Failed sign-in',email,false);save();throw new ApiErr(401,u&&!u.active?'This account is disabled by an administrator.':'Email or password is incorrect.')}
  delete DB.locks[email];const tok=uid('tk')+uid('');DB.sessions[tok]={uid:u.id,last:Date.now(),t:Date.now()};sess.set(tok);await audit(u,'Signed in',u.role);save();return u},
 async logout(){const u=curUser();if(u)await audit(u,'Signed out','');delete DB.sessions[sess.get()];sess.set(null);save()}
};
