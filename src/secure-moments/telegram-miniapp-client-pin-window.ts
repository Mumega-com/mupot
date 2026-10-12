// mupot — the Mini App page script for W4.2 (TELEGRAM_MINIAPP_PIN_WINDOW). A full variant of the W4.1 script
// (telegram-miniapp-client.ts), served ONLY while the sub-flag is on, so flag off stays byte-identical to W4.1. It adds:
//   - setup with a choice of unlock method (fingerprint/face, or a 6-digit PIN) and of the trusted-device window;
//   - a PIN device keeps its device secret in the Mini App's device storage (DeviceStorage, else localStorage) and asks for
//     the PIN on every decision outside a window (the SERVER checks the PIN; this script only forwards it);
//   - after a won decision the server may return a trust secret + trusted_until: it is cached outside BiometricManager for
//     the window only, and used for routine decisions with no prompt. Every refusal falls back to the full prompt.
// It holds no mupot secret of its own. Server text is written with textContent; view_html is HTML the SERVER escaped.
export const TG_SCRIPT_PIN_WINDOW = `
(function(){
var app=document.getElementById('app'),out=document.getElementById('status');
function show(title,message,ok){out.textContent='';var h=document.createElement('strong');h.textContent=title;var p=document.createElement('p');p.textContent=message;out.appendChild(h);out.appendChild(p);out.className='card '+(ok?'status-ok':'status-warn')}
function lock(on){var bs=document.querySelectorAll('button[data-act]');for(var i=0;i<bs.length;i++)bs[i].disabled=on||(linkBusy&&bs[i].getAttribute('data-act')==='passkey')}
var tg=window.Telegram&&window.Telegram.WebApp;
if(!tg||!tg.initData){app.textContent='';show('Open this from Telegram','This page only works inside the Telegram app, opened from the bot.',false);return}
try{tg.ready();tg.expand()}catch(e){}
if(!(tg.isVersionAtLeast&&tg.isVersionAtLeast('8.0'))){app.textContent='';show('Update Telegram','This needs Telegram with Bot API 8.0 or newer (it signs the launch data). Update the app and open this page again from the bot.',false);return}
var bm=tg.BiometricManager;
var DEV_KEY='mupot_tg_pin_device',TRUST_KEY='mupot_tg_trust';
var WINDOWS=[[0,'Every time'],[1800,'30 minutes'],[7200,'2 hours'],[28800,'8 hours'],[86400,'24 hours'],[604800,'7 days']];
async function post(path,body){body.init_data=tg.initData;var r=await fetch(path,{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var j={};try{j=await r.json()}catch(e){}return{status:r.status,json:j}}
function sGet(k){return new Promise(function(res){try{var ds=tg.DeviceStorage;if(ds&&ds.getItem){ds.getItem(k,function(err,v){res(err?null:(v||null))});return}}catch(e){}try{res(window.localStorage.getItem(k))}catch(e){res(null)}})}
function sSet(k,v){return new Promise(function(res){try{var ds=tg.DeviceStorage;if(ds&&ds.setItem){ds.setItem(k,v,function(err,ok){res(!err&&ok!==false)});return}}catch(e){}try{window.localStorage.setItem(k,v);res(true)}catch(e){res(false)}})}
function sDel(k){return new Promise(function(res){try{var ds=tg.DeviceStorage;if(ds&&ds.removeItem){ds.removeItem(k,function(){res(true)});return}}catch(e){}try{window.localStorage.removeItem(k)}catch(e){}res(true)})}
async function readTrust(){var raw=await sGet(TRUST_KEY);if(!raw)return null;try{var t=JSON.parse(raw);if(t&&typeof t.t==='string'&&typeof t.u==='string'&&Date.parse(t.u)>Date.now())return t}catch(e){}await sDel(TRUST_KEY);return null}
function bmInit(){return new Promise(function(res){if(!bm){res(false);return}if(bm.isInited){res(true);return}try{bm.init(function(){res(!!bm.isInited)})}catch(e){res(false)}})}
function bmAccess(reason){return new Promise(function(res){if(bm.isAccessGranted){res(true);return}try{bm.requestAccess({reason:reason},function(ok){res(!!ok)})}catch(e){res(false)}})}
function bmAuth(reason){return new Promise(function(res){try{bm.authenticate({reason:reason},function(ok,token){if(!ok){res({cancelled:true});return}if(typeof token!=='string'||!token){res({noToken:true});return}res({token:token})})}catch(e){res({cancelled:true})}})}
function settingsHelp(){var b=document.createElement('button');b.type='button';b.textContent='Open Telegram biometric settings';b.addEventListener('click',function(){try{bm.openSettings()}catch(e){}});out.appendChild(b)}
function authFailure(r){if(r.noToken){show('Set this phone up again','No saved device secret was found on this phone (it was removed or never saved). Go to My Account on the dashboard, Telegram device, Set up this phone.',false)}else{show('Not confirmed','The biometric check was cancelled or failed. Nothing was decided.',false)}}
var curMoment=null,curKind=null,linkBusy=false;
function passkeyButton(parent){
 if(!curMoment)return;
 var b=document.createElement('button');b.type='button';b.setAttribute('data-act','passkey');b.textContent='Approve with passkey in your browser';
 b.addEventListener('click',async function(){
  if(linkBusy)return;linkBusy=true;b.disabled=true;
  try{
   var r=await post('/m/tg/'+encodeURIComponent(curMoment)+'/passkey-link',{});
   if(!r.json.ok||typeof r.json.url!=='string'){show(r.json.title||'No link',r.json.message||'A browser link could not be made now.',false);linkBusy=false;b.disabled=false;return}
   show('Opening your browser','Decide there with your passkey. This link works once; nothing is decided until you do.',true);
   try{tg.openLink(r.json.url)}catch(e){var a=document.createElement('a');a.href=r.json.url;a.rel='noopener noreferrer';a.target='_blank';a.textContent='Open the passkey page';out.appendChild(a)}
  }catch(e){show('No link','Something went wrong. Nothing was decided.',false);linkBusy=false;b.disabled=false}
 });
 parent.appendChild(b)}
function bmStore(token){return new Promise(function(res){try{bm.updateBiometricToken(token,function(ok){res(!!ok)})}catch(e){res(false)}})}
async function ready(){
 if(!(await bmInit())||!bm.isBiometricAvailable){show('Biometrics unavailable','This phone or Telegram client cannot unlock a device secret with fingerprint or face. Use your PIN (set this phone up with a PIN from My Account) or your passkey in your browser instead.',false);if(!document.querySelector('button[data-act=passkey]'))passkeyButton(out);return false}
 if(!(await bmAccess('Confirm decisions in this workspace'))){show('Permission needed','Allow Telegram to use biometrics for this bot, then try again.',false);settingsHelp();return false}
 return true}
function askPin(parent){
 return new Promise(function(res){
  var wrap=document.createElement('div');wrap.className='row';
  var lab=document.createElement('label');lab.textContent='Your 6-digit PIN ';
  var inp=document.createElement('input');inp.type='password';inp.setAttribute('inputmode','numeric');inp.setAttribute('autocomplete','off');inp.setAttribute('maxlength','6');inp.setAttribute('pattern','[0-9]{6}');inp.setAttribute('data-act','pin');
  var ok=document.createElement('button');ok.type='button';ok.className='primary';ok.setAttribute('data-act','pin-ok');ok.textContent='Confirm';
  var no=document.createElement('button');no.type='button';no.setAttribute('data-act','pin-cancel');no.textContent='Cancel';
  function done(v){try{parent.removeChild(wrap)}catch(e){}res(v)}
  ok.addEventListener('click',function(){var v=String(inp.value||'');if(!/^[0-9]{6}$/.test(v)){show('PIN needed','Enter exactly 6 digits.',false);return}done(v)});
  no.addEventListener('click',function(){done(null)});
  lab.appendChild(inp);wrap.appendChild(lab);wrap.appendChild(ok);wrap.appendChild(no);parent.appendChild(wrap)})}
var mode=app.getAttribute('data-mode'),ref=app.getAttribute('data-ref');
async function remember(j){
 // The device secret ROTATES on every won secret-path decision; the trust secret on every won decision that has one.
 var problem='';
 if(j.device_token_next){
  var pinDev=await sGet(DEV_KEY);
  var saved=pinDev?await sSet(DEV_KEY,j.device_token_next):await bmStore(j.device_token_next);
  if(!saved)problem=' But this phone could not save its next device secret, so set it up again from My Account (Telegram device) before the next decision.';
 }
 if(j.trust_token_next&&typeof j.trusted_until==='string'){await sSet(TRUST_KEY,JSON.stringify({t:j.trust_token_next,u:j.trusted_until}))}
 else if(j.device_token_next){await sDel(TRUST_KEY)}
 return problem}
async function moment(id){
 var v=await post('/m/tg/view',id?{moment_id:id}:{});
 if(!v.json.ok){app.textContent='';show(v.json.title||'Not available',v.json.message||'This request cannot be shown.',false);return}
 if(v.json.state==='idle'){app.textContent='';show(v.json.title,v.json.message,true);return}
 var momentId=v.json.moment_id;curMoment=momentId;curKind=v.json.kind;
 app.innerHTML='<div id="decision-form"></div>';
 var f=document.getElementById('decision-form');
 f.innerHTML=v.json.view_html;
 var blocked=v.json.passkey_only_actions||[];
 var boxes=f.querySelectorAll('input[name=actions]');
 for(var i=0;i<boxes.length;i++){if(blocked.indexOf(boxes[i].value)>=0){boxes[i].checked=false;boxes[i].disabled=true}}
 var row=document.createElement('div');row.className='row';
 var note=document.createElement('p');note.className='muted';note.textContent='Deciding asks for your fingerprint, face or PIN (unless you chose to trust this phone for a while). Opening this page decided nothing.';
 var ok=document.createElement('button');ok.className='primary';ok.type='button';ok.setAttribute('data-act','approve');ok.textContent=v.json.approve_label;
 var no=document.createElement('button');no.className='danger';no.type='button';no.setAttribute('data-act','deny');no.textContent='Deny';
 row.appendChild(ok);row.appendChild(no);f.appendChild(note);f.appendChild(row);
 var row2=document.createElement('div');row2.className='row';passkeyButton(row2);f.appendChild(row2);
 function params(decision){var acts=[];var cs=f.querySelectorAll('input[name=actions]');for(var i=0;i<cs.length;i++){if(cs[i].checked&&!cs[i].disabled)acts.push(cs[i].value)}var d=f.querySelector('select[name=duration_minutes]');return{moment_id:momentId,decision:decision,actions:acts,duration_minutes:d?d.value:undefined}}
 function finish(res,extra){
  show(res.json.title||'Result',(res.json.message||'No message.')+(extra||''),res.status===200&&!extra);
  if(res.status===200){f.hidden=true}else{lock(false)}}
 async function decide(decision){
  lock(true);show('Waiting for you','Confirm to continue. Nothing has been decided yet.',true);
  try{
   var p=params(decision);
   var ch=await post('/m/tg/challenge',p);
   if(!ch.json.ok){show(ch.json.title||'Not started',ch.json.message||'This request cannot be decided now.',false);lock(false);return}
   p.nonce=ch.json.nonce;
   // 1. Inside a trusted window a routine decision needs no prompt: the cached trust secret rides alone. A seed approve is never routine.
   var trust=await readTrust();
   if(trust&&(curKind==='elevation'||decision==='deny')){
    var tp=Object.assign({},p);tp.trust_token=trust.t;
    var tr=await post('/m/tg/decide',tp);
    var pr=await remember(tr.json); // a rotated trust token is kept from ANY response that carries it
    var fall=(tr.json.code==='window_expired'||tr.json.code==='prompt_required'||tr.json.code==='device_not_recognised');
    if(!fall){if(tr.json.code==='device_removed'){await sDel(TRUST_KEY)}finish(tr,pr);return} // anything else (a spent nonce, a lost race, a won decision) is shown, never retried
    await sDel(TRUST_KEY); // the server refused the TRUST proof before touching the nonce: answer the SAME challenge with the full prompt
   }
   // 2. The full proof: a PIN device sends its secret and the PIN; a biometric device unlocks its secret with fingerprint or face.
   var pinDevice=await sGet(DEV_KEY);
   if(pinDevice){
    var pin=await askPin(f);
    if(!pin){show('Not confirmed','Cancelled. Nothing was decided.',false);lock(false);return}
    p.device_token=pinDevice;p.pin=pin;
   }else{
    if(!(await ready())){lock(false);return}
    var au=await bmAuth('Confirm: '+(decision==='approve'?'approve':'deny')+' this request');
    if(!au.token){authFailure(au);lock(false);return}
    p.device_token=au.token;
   }
   var res=await post('/m/tg/decide',p);
   var problem=await remember(res.json);
   if(res.json.code==='pin_lockout'||res.json.code==='device_removed'){await sDel(DEV_KEY);await sDel(TRUST_KEY)}
   finish(res,problem);
  }catch(e){show('Not decided','Something went wrong. Nothing was decided.',false);lock(false)}
 }
 ok.addEventListener('click',function(){decide('approve')});
 no.addEventListener('click',function(){decide('deny')});
}
async function enrol(token){
 app.textContent='';
 var bioOk=(await bmInit())&&!!bm.isBiometricAvailable;
 var p=document.createElement('p');p.textContent='This lets you confirm decisions on this phone. It adds no permissions.';app.appendChild(p);
 var ml=document.createElement('label');ml.textContent='Confirm with ';
 var ms=document.createElement('select');ms.setAttribute('data-act','method');
 if(bioOk){var o1=document.createElement('option');o1.value='biometric';o1.textContent='Fingerprint or face';ms.appendChild(o1)}
 var o2=document.createElement('option');o2.value='pin';o2.textContent='A 6-digit PIN';ms.appendChild(o2);
 ml.appendChild(ms);app.appendChild(ml);
 var pl=document.createElement('label');pl.textContent=' PIN ';
 var pi=document.createElement('input');pi.type='password';pi.setAttribute('inputmode','numeric');pi.setAttribute('autocomplete','off');pi.setAttribute('maxlength','6');pi.setAttribute('data-act','pin1');
 var pl2=document.createElement('label');pl2.textContent=' Repeat PIN ';
 var pi2=document.createElement('input');pi2.type='password';pi2.setAttribute('inputmode','numeric');pi2.setAttribute('autocomplete','off');pi2.setAttribute('maxlength','6');pi2.setAttribute('data-act','pin2');
 pl.appendChild(pi);pl2.appendChild(pi2);app.appendChild(pl);app.appendChild(pl2);
 function syncPin(){var on=ms.value==='pin';pl.hidden=!on;pl2.hidden=!on}
 ms.addEventListener('change',syncPin);syncPin();
 var wl=document.createElement('label');wl.textContent=' After I confirm, trust this phone for ';
 var ws=document.createElement('select');ws.setAttribute('data-act','window');
 for(var i=0;i<WINDOWS.length;i++){var o=document.createElement('option');o.value=String(WINDOWS[i][0]);o.textContent=WINDOWS[i][1];if(WINDOWS[i][0]===1800)o.selected=true;ws.appendChild(o)}
 wl.appendChild(ws);app.appendChild(wl);
 var hint=document.createElement('p');hint.className='muted';hint.textContent='While trusted, routine approvals need no prompt. Sensitive grants always need a passkey. You can change this later in My Account.';app.appendChild(hint);
 var b=document.createElement('button');b.className='primary';b.type='button';b.setAttribute('data-act','enrol');b.textContent='Set up this device';app.appendChild(b);
 b.addEventListener('click',async function(){
  lock(true);
  try{
   var method=ms.value,win=parseInt(ws.value,10),pin='';
   if(method==='pin'){pin=String(pi.value||'');if(!/^[0-9]{6}$/.test(pin)){show('PIN needed','The PIN must be exactly 6 digits.',false);lock(false);return}if(pin!==String(pi2.value||'')){show('PINs differ','The two PINs are not the same.',false);lock(false);return}}
   var base='/m/tg/enrol/'+encodeURIComponent(token);
   var s=await post(base+'/start',{});
   if(!s.json.ok){show(s.json.title||'Not started',s.json.message||'Setup could not start.',false);lock(false);return}
   var back;
   if(method==='biometric'){
    if(!(await ready())){lock(false);return}
    if(!(await bmStore(s.json.device_token))){show('Not saved','Telegram could not store the device secret.',false);lock(false);return}
    var au=await bmAuth('Confirm this device');
    if(!au.token){authFailure(au);lock(false);return}
    back=au.token;
    await sDel(DEV_KEY);
   }else{
    if(!(await sSet(DEV_KEY,s.json.device_token))){show('Not saved','This phone could not store the device secret.',false);lock(false);return}
    back=await sGet(DEV_KEY);
    if(!back){show('Not saved','This phone could not store the device secret.',false);lock(false);return}
   }
   var body={device_token:back,unlock_mode:method,trust_window_seconds:win};
   if(method==='pin')body.pin=pin;
   var c=await post(base+'/confirm',body);
   pi.value='';pi2.value='';
   show(c.json.title||'Result',c.json.message||'No message.',c.status===200);
   if(c.status!==200){if(method==='pin')await sDel(DEV_KEY);lock(false)}else{await sDel(TRUST_KEY);b.hidden=true}
  }catch(e){show('Not set up','Something went wrong.',false);lock(false)}
 });
}
if(mode==='enrol'){enrol(ref)}
else if(mode==='moment'){moment(ref)}
else{moment('')}
})();
`
