// mupot - the inline script of the credential page (served under the per-response CSP nonce), plus the path of the
// vendored HPKE sealer it needs. The script reads the secret from the password field, seals it IN THE BROWSER
// with MupotHpke.seal (src/secure-drop/vendor/hpke-seal.v1.js) to the host key the page names, and POSTs only
// {enc, ct} and the WebAuthn assertion to this page's own sub-paths. Server-supplied text is written with
// textContent only. It computes the host key fingerprint itself and refuses to seal if the server's differs.
import { COMMON } from '../secure-moments/client'
import { DROP_MAX_PLAINTEXT_BYTES } from './config'
import { HPKE_BUNDLE_SRI } from './hpke-bundle.generated'

export const HPKE_ASSET_PATH = '/m/assets/hpke-seal.v1.js'
export const HPKE_ASSET = { src: HPKE_ASSET_PATH, integrity: HPKE_BUNDLE_SRI } as const

export const CREDENTIAL_SCRIPT = `${COMMON}
(function(){
if(!window.PublicKeyCredential||!window.MupotHpke||!window.crypto||!crypto.subtle){show('Not available','This browser cannot seal and confirm here. Open the link in a current browser.',false);lock(true);return}
var form=document.getElementById('drop-form');
var secretEl=document.getElementById('secret');
var pub=form.getAttribute('data-pub'),dropId=form.getAttribute('data-drop-id'),fpServer=form.getAttribute('data-fp'),agentId=form.getAttribute('data-agent-id'),dropName=form.getAttribute('data-name');
var MAX=${DROP_MAX_PLAINTEXT_BYTES};
var fpOk=null;
form.addEventListener('submit',function(ev){ev.preventDefault()});
MupotHpke.fingerprint(pub).then(function(fp){
 var g=fp.match(/.{4}/g).join(' ');
 document.getElementById('fp-computed').textContent=g;
 if(fp!==fpServer){show('Fingerprint mismatch','The key this page would seal to does not match the fingerprint it displays. Do NOT paste a secret. Tell an administrator.',false);lock(true);return}
 fpOk=fp;
}).catch(function(){show('Key problem','The host key on this page is not valid. Do not paste a secret.',false);lock(true)});
async function act(decision){
 lock(true);
 try{
  var p={decision:decision,csrf:form.getAttribute('data-csrf')};
  if(decision==='provide'){
   if(!fpOk){show('Not ready','The host key fingerprint has not been checked yet. Try again in a moment.',false);lock(false);return}
   var v=secretEl.value;
   if(!v){show('Nothing to send','Paste the secret into the field first.',false);lock(false);return}
   var bytes=new TextEncoder().encode(v);
   if(bytes.length>MAX){bytes.fill(0);show('Too large','The secret is larger than '+MAX+' bytes.',false);lock(false);return}
   show('Sealing','Encrypting in this browser to the host key. Nothing readable leaves this page.',true);
   var sealed=await MupotHpke.seal(pub,'mupot-secure-drop/v2|'+agentId+'|'+dropId+'|'+dropName+'|'+fpOk,dropId,bytes);
   bytes.fill(0);
   p.enc=sealed.enc;p.ct=sealed.ct;
  }
  show('Waiting for your passkey','Confirm on this device. Nothing has been sent yet.',true);
  var ch=await post('/challenge',p);
  if(!ch.json.ok){show('Not started',ch.json.message||'This request cannot be decided now.',false);lock(false);return}
  var o=ch.json.publicKey;o.challenge=b64uToBuf(o.challenge);
  o.allowCredentials=(o.allowCredentials||[]).map(function(c){return{type:c.type,id:b64uToBuf(c.id)}});
  var cred=await navigator.credentials.get({publicKey:o});
  p.credential={id:cred.id,rawId:bufToB64u(cred.rawId),type:cred.type,response:{clientDataJSON:bufToB64u(cred.response.clientDataJSON),authenticatorData:bufToB64u(cred.response.authenticatorData),signature:bufToB64u(cred.response.signature)}};
  var res=await post('/decide',p);
  show(res.json.title||'Result',res.json.message||'No message.',res.status===200);
  if(res.status===200){secretEl.value='';secretEl.disabled=true}else{lock(false)}
 }catch(e){show('Not sent',explain(e),false);lock(false)}
}
var bs=form.querySelectorAll('button[data-act]');
for(var i=0;i<bs.length;i++){bs[i].addEventListener('click',function(ev){act(ev.currentTarget.getAttribute('data-act'))})}
})();
`
