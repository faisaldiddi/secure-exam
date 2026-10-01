(async()=>{
 const video=document.getElementById('monitorVideo'), state=document.getElementById('monitorState'), lock=document.getElementById('lockOverlay');
 if(!video) return;
 let lost=0, stream=null, sent=false;
 async function report(type){try{await fetch('/api/security-event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,paperId:document.body.dataset.paper})});}catch{}}
 try{
   stream=await navigator.mediaDevices.getUserMedia({video:{width:320,height:240},audio:false}); video.srcObject=stream;
   state.textContent='Camera active • identity-presence monitoring';
   const track=stream.getVideoTracks()[0];
   track.addEventListener('ended',()=>{report('CAMERA_BLOCKED');lock.classList.add('show')});
   // Review-1 lightweight presence monitor: camera health + page visibility + periodic luma sampling.
   const c=document.createElement('canvas'); c.width=64;c.height=48; const x=c.getContext('2d',{willReadFrequently:true});
   setInterval(()=>{
     if(video.readyState<2) return;
     x.drawImage(video,0,0,64,48); const d=x.getImageData(0,0,64,48).data; let sum=0; for(let i=0;i<d.length;i+=4)sum+=(d[i]+d[i+1]+d[i+2])/3; const avg=sum/(d.length/4);
     const blocked=avg<7;
     if(blocked){lost++;state.textContent=`Camera appears blocked (${Math.max(0,5-lost)}s)`;state.parentElement.style.background='#fff7ed';}
     else{lost=0;sent=false;state.textContent='Camera active • identity-presence monitoring';state.parentElement.style.background='#ecfdf5';}
     if(lost>=5&&!sent){sent=true;report('CAMERA_BLOCKED');lock.classList.add('show');}
   },1000);
 }catch(e){state.textContent='Camera permission denied — secure viewer locked'; await report('FACE_LOST'); lock.classList.add('show');}
 document.addEventListener('visibilitychange',()=>{if(document.hidden){report('FACE_LOST');lock.classList.add('show')}});
})();
