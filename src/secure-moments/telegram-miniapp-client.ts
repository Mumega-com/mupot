// mupot — the one inline script of the Telegram Mini App pages (served under the per-response CSP nonce, after
// Telegram's own script). It reads Telegram.WebApp.initData, POSTs it with the choice, and uses BiometricManager as
// the unlock for a device secret. It holds no mupot secret. Server-supplied text is written with textContent; the
// request body (view_html) is HTML the SERVER already escaped (the same decision-core views the other channels use).
export const TG_SCRIPT = `
(function(){
var app=document.getElementById('app'),out=document.getElementById('status');
function show(title,message,ok){out.textContent='';var h=document.createElement('strong');h.textContent=title;var p=document.createElement('p');p.textContent=message;out.appendChild(h);out.appendChild(p);out.className='card '+(ok?'status-ok':'status-warn')}
function lock(on){var bs=document.querySelectorAll('button[data-act]');for(var i=0;i<bs.length;i++)bs[i].disabled=on}
var tg=window.Telegram&&window.Telegram.WebApp;
if(!tg||!tg.initData){app.textContent='';show('Open this from Telegram','This page only works inside the Telegram app, opened from the bot.',false);return}
try{tg.ready();tg.expand()}catch(e){}
if(!(tg.isVersionAtLeast&&tg.isVersionAtLeast('8.0'))){app.textContent='';show('Update Telegram','This needs Telegram with Bot API 8.0 or newer (it signs the launch data and can unlock a device secret). Update the app and open this page again from the bot.',false);return}
var bm=tg.BiometricManager;
async function post(path,body){body.init_data=tg.initData;var r=await fetch(path,{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var j={};try{j=await r.json()}catch(e){}return{status:r.status,json:j}}
function bmInit(){return new Promise(function(res){if(!bm){res(false);return}if(bm.isInited){res(true);return}try{bm.init(function(){res(!!bm.isInited)})}catch(e){res(false)}})}
function bmAccess(reason){return new Promise(function(res){if(bm.isAccessGranted){res(true);return}try{bm.requestAccess({reason:reason},function(ok){res(!!ok)})}catch(e){res(false)}})}
function bmAuth(reason){return new Promise(function(res){try{bm.authenticate({reason:reason},function(ok,token){if(!ok){res({cancelled:true});return}if(typeof token!=='string'||!token){res({noToken:true});return}res({token:token})})}catch(e){res({cancelled:true})}})}
function settingsHelp(){var b=document.createElement('button');b.type='button';b.textContent='Open Telegram biometric settings';b.addEventListener('click',function(){try{bm.openSettings()}catch(e){}});out.appendChild(b)}
function authFailure(r){if(r.noToken){show('Set this phone up again','No saved device secret was found on this phone (it was removed or never saved). Go to My Account on the dashboard, Telegram device, Set up this phone.',false)}else{show('Not confirmed','The biometric check was cancelled or failed. Nothing was decided.',false)}}
function bmStore(token){return new Promise(function(res){try{bm.updateBiometricToken(token,function(ok){res(!!ok)})}catch(e){res(false)}})}
async function ready(){
 if(!(await bmInit())||!bm.isBiometricAvailable){show('Biometrics unavailable','This phone or Telegram client cannot unlock a device secret with fingerprint or face. Open the request on a browser with a passkey instead.',false);return false}
 if(!(await bmAccess('Confirm decisions in this workspace'))){show('Permission needed','Allow Telegram to use biometrics for this bot, then try again.',false);settingsHelp();return false}
 return true}
var mode=app.getAttribute('data-mode'),ref=app.getAttribute('data-ref');
async function moment(id){
 var v=await post('/m/tg/view',id?{moment_id:id}:{});
 if(!v.json.ok){app.textContent='';show(v.json.title||'Not available',v.json.message||'This request cannot be shown.',false);return}
 if(v.json.state==='idle'){app.textContent='';show(v.json.title,v.json.message,true);return}
 var momentId=v.json.moment_id;
 app.innerHTML='<div id="decision-form"></div>';
 var f=document.getElementById('decision-form');
 f.innerHTML=v.json.view_html;
 var blocked=v.json.passkey_only_actions||[];
 var boxes=f.querySelectorAll('input[name=actions]');
 for(var i=0;i<boxes.length;i++){if(blocked.indexOf(boxes[i].value)>=0){boxes[i].checked=false;boxes[i].disabled=true}}
 var row=document.createElement('div');row.className='row';
 var note=document.createElement('p');note.className='muted';note.textContent='Deciding asks for your fingerprint or face. Opening this page decided nothing.';
 var ok=document.createElement('button');ok.className='primary';ok.type='button';ok.setAttribute('data-act','approve');ok.textContent=v.json.approve_label+' with biometrics';
 var no=document.createElement('button');no.className='danger';no.type='button';no.setAttribute('data-act','deny');no.textContent='Deny';
 row.appendChild(ok);row.appendChild(no);f.appendChild(note);f.appendChild(row);
 function params(decision){var acts=[];var cs=f.querySelectorAll('input[name=actions]');for(var i=0;i<cs.length;i++){if(cs[i].checked&&!cs[i].disabled)acts.push(cs[i].value)}var d=f.querySelector('select[name=duration_minutes]');return{moment_id:momentId,decision:decision,actions:acts,duration_minutes:d?d.value:undefined}}
 async function decide(decision){
  lock(true);show('Waiting for you','Confirm with your fingerprint or face. Nothing has been decided yet.',true);
  try{
   var p=params(decision);
   var ch=await post('/m/tg/challenge',p);
   if(!ch.json.ok){show(ch.json.title||'Not started',ch.json.message||'This request cannot be decided now.',false);lock(false);return}
   if(!(await ready())){lock(false);return}
   var au=await bmAuth('Confirm: '+(decision==='approve'?'approve':'deny')+' this request');
   if(!au.token){authFailure(au);lock(false);return}
   p.nonce=ch.json.nonce;p.device_token=au.token;
   var res=await post('/m/tg/decide',p);
   show(res.json.title||'Result',res.json.message||'No message.',res.status===200);
   // The device secret ROTATES on every won decision: store the next one now, or the next decision needs a new setup.
   if(res.json.device_token_next){var saved=await bmStore(res.json.device_token_next);if(!saved){show(res.json.title||'Result',(res.json.message||'')+' But this phone could not save its next device secret, so set it up again from My Account (Telegram device) before the next decision.',false)}}
   if(res.status===200){f.hidden=true}else{lock(false)}
  }catch(e){show('Not decided','Something went wrong. Nothing was decided.',false);lock(false)}
 }
 ok.addEventListener('click',function(){decide('approve')});
 no.addEventListener('click',function(){decide('deny')});
}
async function enrol(token){
 app.textContent='';
 var b=document.createElement('button');b.className='primary';b.type='button';b.setAttribute('data-act','enrol');b.textContent='Set up this device';
 var p=document.createElement('p');p.textContent='This lets you confirm decisions on this phone with your fingerprint or face. It adds no permissions.';
 app.appendChild(p);app.appendChild(b);
 b.addEventListener('click',async function(){
  lock(true);
  try{
   var base='/m/tg/enrol/'+encodeURIComponent(token);
   var s=await post(base+'/start',{});
   if(!s.json.ok){show(s.json.title||'Not started',s.json.message||'Setup could not start.',false);lock(false);return}
   if(!(await ready())){lock(false);return}
   if(!(await bmStore(s.json.device_token))){show('Not saved','Telegram could not store the device secret.',false);lock(false);return}
   var back=await bmAuth('Confirm this device');
   if(!back.token){authFailure(back);lock(false);return}
   var c=await post(base+'/confirm',{device_token:back.token});
   show(c.json.title||'Result',c.json.message||'No message.',c.status===200);
   if(c.status!==200)lock(false);else b.hidden=true;
  }catch(e){show('Not set up','Something went wrong.',false);lock(false)}
 });
}
if(mode==='enrol'){enrol(ref)}
else if(mode==='moment'){moment(ref)}
else{moment('')}
})();
`
