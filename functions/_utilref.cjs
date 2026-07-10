const admin=require("firebase-admin");
if(!admin.apps.length)admin.initializeApp({projectId:"minpaku-v2"});
const db=admin.firestore();const FV=admin.firestore.FieldValue;
const pnl=require("./api/pnl")(db);
const PROPS=["RZV9IwtQgMAsvrdM3j8J","tsZybhDMcPrxqgcRy7wp"];
function invoke(h,params,body){return new Promise(r=>{let p,c=200;const res={status(x){c=x;return this},json(j){p=j;r({c,p})}};Promise.resolve(h({params,body:body||{},query:{},user:{role:"owner"}},res)).catch(e=>r({c:500,p:{error:e.message}}));});}
async function resetUtil(pid,ym){const ref=db.collection("propertyMonthlyPnL").doc(`${pid}_${ym}`);const doc=await ref.get();if(!doc.exists)return false;const d=doc.data();const upd={utilitiesIndex:[],updatedAt:FV.serverTimestamp()};for(const[cid,e]of Object.entries(d.expenses||{}))if(e&&e.source==="utilities")upd[`expenses.${cid}`]=FV.delete();await ref.update(upd);return true;}
(async()=>{
  const months=new Set();
  for(const pid of PROPS){const s=await db.collection("propertyMonthlyPnL").where("propertyId","==",pid).get();s.forEach(x=>months.add(x.data().yearMonth));}
  const list=[...months].filter(Boolean).sort();
  console.log("対象月:",list.join(","));
  for(const ym of list){
    for(const pid of PROPS){
      if(!(await resetUtil(pid,ym)))continue;
      const {p}=await invoke(pnl.cores.importUtilities,{propertyId:pid,yearMonth:ym},{});
      if(p&&p.error&&!/未設定/.test(p.error))console.log(`  ${pid} ${ym}: ERR ${p.error}`);
    }
    process.stdout.write(`${ym} `);
  }
  console.log("\n\n=== 5月 水道光熱費 検証 ===");
  const cats={};(await db.collection("expenseCategories").get()).docs.forEach(x=>cats[x.id]=x.data().name);
  for(const[l,pid]of[["宿小町",PROPS[0]],["the Terrace",PROPS[1]]]){
    const d=(await db.collection("propertyMonthlyPnL").doc(`${pid}_2026-05`).get()).data();
    console.log(`\n■ ${l}`);
    (d.utilitiesIndex||[]).forEach(it=>console.log(`   ¥${it.amount}  ${it.fileName}`));
    console.log(`   費目: ${Object.entries(d.expenses||{}).filter(([id,e])=>e.source==="utilities").map(([id,e])=>`${cats[id]}=${e.amount}`).join(" / ")||"なし"}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR:",e.message);process.exit(1)});
