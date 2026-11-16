const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\n    init\(\);/,'');
function setup(fetch) {
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',className:'',dataset:{},disabled:false,resets:0,
      reset(){this.resets++;},setAttribute(){},classList:{toggle(){}},querySelectorAll(){return [];}});
    return elements.get(id);
  };
  const context=vm.createContext({console,crypto,fetch,TypeError,AbortSignal,Date,setTimeout:()=>0,localStorage:{getItem:()=>null},window:{location:{protocol:'https:'}},document:{getElementById:element,querySelectorAll:()=>[]}});
  vm.runInContext(source,context);
  vm.runInContext('renderExpenseList = renderSaleList = renderDashboard = () => {};',context);
  return {context,element,run:code=>vm.runInContext(code,context)};
}
const response=(status,body)=>({ok:status<400,status,json:async()=>body,headers:{get:()=> 'application/json'}});

test('database failure keeps the last loaded records and shows a persistent warning',async()=>{
 const {element,run}=setup(async()=>response(503,{error:'Database unavailable.'}));
 run("expenses = [{id:'keep-me'}];");
 await run('loadData()');
 assert.equal(run('expenses[0].id'),'keep-me');
 assert.equal(element('expense-submit').disabled,true);
 assert.match(element('storage-status').textContent,/Saving is paused/);
});

test('Safari network failures keep the entry and retry the same ID without duplicate saves',async()=>{
 let attempts=0;const ids=[];
 const {element,run}=setup(async(path,options)=>{
   if(path==='/api/expenses'){
     ids.push(JSON.parse(options.body).id);
     if(attempts++===0)throw new TypeError('Load failed');
     return response(201,JSON.parse(options.body));
   }
   return response(200,{expenses:[],sales:[]});
 });
 element('expense-date').value='2026-11-16';
 element('expense-amount').value='12.34';
 element('expense-category').value='Rent';
 element('expense-description').value='Keep this entry';
 run('updateStorageStatus(true)');
 await run('handleExpenseSubmit({preventDefault(){}})');
 assert.equal(element('expense-form').resets,0);
 assert.equal(element('expense-description').value,'Keep this entry');
 assert.equal(element('expense-submit').disabled,true);
 run('updateStorageStatus(true)');
 await run('handleExpenseSubmit({preventDefault(){}})');
 assert.equal(ids.length,2);
 assert.equal(ids[0],ids[1]);
 assert.equal(element('expense-form').resets,1);
});

test('year-end report includes the last day and all four quarters',()=>{
 const {element,run}=setup(async()=>{});
 element('report-year').value='2026';
 run(`expenses=[
 {date:'2025-12-31',category:'Rent',amount:900},
 {date:'2026-01-01',category:'Rent',amount:100},
 {date:'2026-04-01',category:'Rent',amount:200},
 {date:'2026-07-01',category:'Rent',amount:300},
 {date:'2026-12-31',category:'Rent',amount:400},
 {date:'2027-01-01',category:'Rent',amount:800}];activeQuarter='year';renderQuarterReport();`);
 assert.match(element('quarter-report').innerHTML,/<td>Rent<\/td><td>\$1,000\.00<\/td>/);
 assert.match(element('quarter-report').innerHTML,/Jan 1, 2026 – Dec 31, 2026/);
});
