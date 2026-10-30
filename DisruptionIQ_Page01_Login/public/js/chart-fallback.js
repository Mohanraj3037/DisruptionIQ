/* DisruptionIQ local chart fallback.
 * Used only when the Chart.js CDN is unavailable. Supports the chart
 * primitives used by this application: doughnut, bar and line.
 */
(() => {
  if (window.Chart) return;
  const NS = 'http://www.w3.org/2000/svg';
  const palette = ['#c9f52d','#6c7b3c','#e1b45e','#d56d55','#8da0a1','#4c6684'];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function el(tag, attrs={}, text='') {
    const n=document.createElementNS(NS,tag);
    Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,String(v)));
    if(text!== '') n.textContent=text;
    return n;
  }
  function Chart(target, config={}) {
    this.target=typeof target==='string'?document.querySelector(target):target;
    this.config=config; this.destroyed=false;
    if(this.target) {
      this.originalId=this.target.id||'';
      this._resize=()=>this.render();
      window.addEventListener('resize',this._resize,{passive:true});
      this.render();
    }
  }
  Chart.defaults={font:{family:'IBM Plex Sans',size:12},color:'#777'};
  Chart.prototype.destroy=function(){
    this.destroyed=true;window.removeEventListener('resize',this._resize);
    if(this.target){this.target.replaceChildren();this.target.removeAttribute('role');}
  };
  Chart.prototype.update=function(){this.render();};
  Chart.prototype.render=function(){
    if(this.destroyed||!this.target)return;
    const cfg=this.config||{}, data=cfg.data||{}, labels=data.labels||[], sets=data.datasets||[];
    const type=cfg.type||'bar', rect=this.target.getBoundingClientRect();
    const w=Math.max(220,Math.round(rect.width||this.target.clientWidth||320));
    const h=Math.max(130,Math.round(rect.height||this.target.clientHeight||180));
    const svg=el('svg',{id:this.originalId,viewBox:`0 0 ${w} ${h}`,width:'100%',height:'100%',role:'img','aria-label':labels.length?`${type} chart: ${labels.join(', ')}`:`${type} chart`});
    svg.style.display='block';svg.style.overflow='visible';svg.style.minHeight='120px';
    const commit=()=>{if(['CANVAS','SVG'].includes(this.target.tagName)){this.target.replaceWith(svg);this.target=svg;}else this.target.replaceChildren(svg);};
    const textColor=cfg.options?.scales?.x?.ticks?.color||cfg.options?.scales?.y?.ticks?.color||'#777';
    const gridColor='rgba(100,100,100,.16)';
    const addText=(x,y,t,size=10,anchor='middle',weight='400')=>svg.append(el('text',{x,y,fill:textColor,'font-size':size,'font-family':'IBM Plex Sans, sans-serif','font-weight':weight,'text-anchor':anchor},t));
    if(type==='doughnut'||type==='pie'){
      const vals=(sets[0]?.data||[]).map(v=>Math.max(0,Number(v)||0)), sum=vals.reduce((a,b)=>a+b,0);
      if(!sum){addText(w/2,h/2,'No recorded data',12);if(this.target!==svg)this.target.replaceChildren(svg);return;}
      const cx=w/2,cy=h/2,r=Math.min(w,h)*.39,inner=type==='doughnut'?r*(parseFloat(cfg.options?.cutout)||68)/100:0;
      let a=-Math.PI/2;
      vals.forEach((v,i)=>{const b=a+Math.PI*2*v/sum,large=b-a>Math.PI?1:0;
        const x1=cx+r*Math.cos(a),y1=cy+r*Math.sin(a),x2=cx+r*Math.cos(b),y2=cy+r*Math.sin(b);
        const ix1=cx+inner*Math.cos(b),iy1=cy+inner*Math.sin(b),ix2=cx+inner*Math.cos(a),iy2=cy+inner*Math.sin(a);
        const d=inner?`M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix2} ${iy2} Z`:`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
        const slice=el('path',{d,fill:sets[0]?.backgroundColor?.[i]||palette[i%palette.length],stroke:sets[0]?.borderColor||'none','stroke-width':sets[0]?.borderWidth||0,tabindex:0});
        slice.append(el('title',{},`${labels[i]||'Segment'}: ${v}`));svg.append(slice);
        a=b;
      });
    } else {
      const horizontal=cfg.options?.indexAxis==='y', left=horizontal?Math.min(112,w*.34):36, right=12, top=12, bottom=labels.length>5?42:30;
      const pw=w-left-right,ph=h-top-bottom, all=sets.flatMap(s=>(s.data||[]).map(v=>Number(v)||0));
      const max=Number(cfg.options?.scales?.[horizontal?'x':'y']?.max)||Math.max(1,...all)*1.15;
      for(let i=0;i<=4;i++){const val=max*i/4;
        if(horizontal){const x=left+pw*i/4;svg.append(el('line',{x1:x,y1:top,x2:x,y2:top+ph,stroke:gridColor}));}
        else {const y=top+ph-ph*i/4;svg.append(el('line',{x1:left,y1:y,x2:left+pw,y2:y,stroke:gridColor}));}
      }
      const groupCount=Math.max(1,labels.length), groupH=ph/groupCount;
      if(horizontal){
        labels.forEach((lab,i)=>{const y=top+groupH*(i+.5);addText(left-8,y+3,String(lab).slice(0,18),10,'end');
          sets.forEach((s,j)=>{const v=Math.max(0,Number(s.data?.[i])||0),bh=Math.min(groupH*.68/sets.length,22),yy=y-groupH*.34+j*bh;
            const bar=el('rect',{x:left,y:yy,width:Math.max(0,pw*v/max),height:Math.max(3,bh-3),rx:4,fill:Array.isArray(s.backgroundColor)?s.backgroundColor[i% s.backgroundColor.length]:s.backgroundColor||palette[j%palette.length],tabindex:0});
            bar.append(el('title',{},`${s.label||'Value'} · ${lab}: ${v}`));svg.append(bar);
          });
        });
      } else {
        labels.forEach((lab,i)=>{const x=left+pw*(i+.5)/groupCount;addText(x,top+ph+16,String(lab).slice(0,12),9);
          const slot=pw/groupCount;
          sets.forEach((s,j)=>{const v=Math.max(0,Number(s.data?.[i])||0),bw=Math.max(2,slot*.68/sets.length),xx=x-slot*.34+j*bw,yy=top+ph-ph*v/max;
            if(type==='line'){
              const prev=i>0?Number(s.data?.[i-1])||0:v,px=left+pw*(i-.5)/groupCount,py=top+ph-ph*prev/max;
              if(i>0)svg.append(el('line',{x1:px,y1:py,x2:x,y2:yy,stroke:s.borderColor||palette[j%palette.length],'stroke-width':2}));
              const point=el('circle',{cx:x,cy:yy,r:3.8,fill:s.borderColor||palette[j%palette.length],tabindex:0});
              point.append(el('title',{},`${s.label||'Value'} · ${lab}: ${v}`));svg.append(point);
            } else {const bar=el('rect',{x:xx,y:yy,width:bw-2,height:Math.max(1,top+ph-yy),rx:3,fill:Array.isArray(s.backgroundColor)?s.backgroundColor[i%s.backgroundColor.length]:s.backgroundColor||palette[j%palette.length],tabindex:0});
              bar.append(el('title',{},`${s.label||'Value'} · ${lab}: ${v}`));svg.append(bar);}
          });
        });
      }
    }
    commit();
  };
  window.Chart=Chart;
})();