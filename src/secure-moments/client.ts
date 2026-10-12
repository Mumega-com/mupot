// mupot — the two inline browser scripts of the secure page (served under a per-response CSP nonce).
// They only call navigator.credentials and POST JSON to the same page's own sub-paths; they hold no secret.
// Server-supplied text is only ever written with textContent.

const COMMON = `
function b64uToBuf(s){var p=s.replace(/-/g,'+').replace(/_/g,'/');while(p.length%4)p+='=';var b=atob(p),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer}
function bufToB64u(b){var u=new Uint8Array(b),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
async function post(path,body){var r=await fetch(location.pathname+path,{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var j={};try{j=await r.json()}catch(e){}return{status:r.status,json:j}}
function show(title,message,ok){var out=document.getElementById('status');out.textContent='';var h=document.createElement('strong');h.textContent=title;var p=document.createElement('p');p.textContent=message;out.appendChild(h);out.appendChild(p);out.className='card '+(ok?'status-ok':'status-warn')}
function lock(on){var bs=document.querySelectorAll('button[data-act]');for(var i=0;i<bs.length;i++)bs[i].disabled=on}
function explain(e){return e&&e.name==='NotAllowedError'?'The passkey prompt was cancelled or timed out.':'The passkey step failed.'}
`

export const DECIDE_SCRIPT = `${COMMON}
(function(){
if(!window.PublicKeyCredential){show('Passkeys not available','This browser cannot use passkeys. Open the link in a browser that can.',false);lock(true);return}
var form=document.getElementById('decision-form');
function params(decision){var fd=new FormData(form);return{decision:decision,actions:fd.getAll('actions'),duration_minutes:fd.get('duration_minutes'),csrf:form.getAttribute('data-csrf')}}
async function decide(decision){
 lock(true);show('Waiting for your passkey','Confirm on this device. Nothing has been decided yet.',true);
 try{
  var p=params(decision);
  var ch=await post('/challenge',p);
  if(!ch.json.ok){show('Not started',ch.json.message||'This request cannot be decided now.',false);lock(false);return}
  var o=ch.json.publicKey;o.challenge=b64uToBuf(o.challenge);
  o.allowCredentials=(o.allowCredentials||[]).map(function(c){return{type:c.type,id:b64uToBuf(c.id)}});
  var cred=await navigator.credentials.get({publicKey:o});
  p.credential={id:cred.id,rawId:bufToB64u(cred.rawId),type:cred.type,response:{clientDataJSON:bufToB64u(cred.response.clientDataJSON),authenticatorData:bufToB64u(cred.response.authenticatorData),signature:bufToB64u(cred.response.signature)}};
  var res=await post('/decide',p);
  show(res.json.title||'Result',res.json.message||'No message.',res.status===200);
  if(res.status===200){var f=document.getElementById('decision-form');if(f)f.hidden=true}else{lock(false)}
 }catch(e){show('Not decided',explain(e),false);lock(false)}
}
var bs=form.querySelectorAll('button[data-act]');
for(var i=0;i<bs.length;i++){bs[i].addEventListener('click',function(ev){decide(ev.currentTarget.getAttribute('data-act'))})}
})();
`

export const ENROL_SCRIPT = `${COMMON}
(function(){
if(!window.PublicKeyCredential){show('Passkeys not available','This browser cannot create passkeys. Open the link in a browser that can.',false);lock(true);return}
var box=document.getElementById('enrol-box');
async function enrol(){
 lock(true);show('Waiting for your passkey','Follow the prompt on this device.',true);
 try{
  var csrf=box.getAttribute('data-csrf');
  var op=await post('/options',{csrf:csrf});
  if(!op.json.ok){show('Not started',op.json.message||'This link cannot be used.',false);lock(false);return}
  var o=op.json.publicKey;o.challenge=b64uToBuf(o.challenge);o.user.id=b64uToBuf(o.user.id);
  o.excludeCredentials=(o.excludeCredentials||[]).map(function(c){return{type:c.type,id:b64uToBuf(c.id)}});
  var cred=await navigator.credentials.create({publicKey:o});
  var tr=typeof cred.response.getTransports==='function'?cred.response.getTransports():[];
  var res=await post('/finish',{csrf:csrf,credential:{id:cred.id,rawId:bufToB64u(cred.rawId),type:cred.type,response:{clientDataJSON:bufToB64u(cred.response.clientDataJSON),attestationObject:bufToB64u(cred.response.attestationObject),transports:tr}}});
  show(res.json.title||'Result',res.json.message||'No message.',res.status===200);
  if(res.status===200){box.hidden=true}else{lock(false)}
 }catch(e){show('Not registered',explain(e),false);lock(false)}
}
document.getElementById('enrol-btn').addEventListener('click',enrol);
})();
`
