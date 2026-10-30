'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
class MockNode{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.attrs={};this.children=[];this.style={};this.id='';this.parent=null;}
  setAttribute(k,v){this.attrs[k]=String(v);if(k==='id')this.id=String(v);}
  removeAttribute(k){delete this.attrs[k];}
  append(node){this.children.push(node);node.parent=this;}
  replaceChildren(...nodes){this.children=nodes;nodes.forEach(n=>n.parent=this);}
  replaceWith(node){if(this.parent){const a=this.parent.children,i=a.indexOf(this);if(i>=0)a[i]=node;}node.parent=this.parent;}
  getBoundingClientRect(){return {width:480,height:220};}
}
const parent=new MockNode('div'),canvas=new MockNode('canvas');canvas.id='chartA';parent.append(canvas);
const document={querySelector:s=>s==='#chartA'?canvas:null,createElementNS:(_ns,tag)=>new MockNode(tag)};
const window={addEventListener(){},removeEventListener(){}};
vm.runInNewContext(fs.readFileSync('public/js/chart-fallback.js','utf8'),{window,document,console,Math,Number,String,Array,Object});
assert.equal(typeof window.Chart,'function','fallback installs Chart constructor when CDN is absent');
const chart=new window.Chart(canvas,{type:'doughnut',data:{labels:['A','B'],datasets:[{data:[3,7],backgroundColor:['#111','#eee']}]},options:{cutout:'70%'}});
assert.equal(parent.children[0].tagName,'SVG','canvas is replaced by a visible SVG chart');
assert.ok(parent.children[0].children.some(n=>n.tagName==='PATH'),'doughnut renders segments');
chart.config={type:'bar',data:{labels:['One','Two'],datasets:[{data:[2,5]}]},options:{}};chart.update();
assert.equal(parent.children[0].tagName,'SVG','updates replace prior SVG rather than nesting canvases');
assert.ok(parent.children[0].children.some(n=>n.tagName==='RECT'),'bar chart renders bars');
chart.config={type:'line',data:{labels:['One','Two','Three'],datasets:[{data:[2,5,3],borderColor:'#333'}]},options:{}};chart.update();
assert.ok(parent.children[0].children.some(n=>n.tagName==='LINE'),'line chart renders data segments');
chart.destroy();
console.log('PASS local chart fallback renders doughnut, bar and line charts; updates and destroy are safe');
