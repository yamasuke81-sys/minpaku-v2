const a=require("firebase-admin");a.initializeApp({projectId:"minpaku-v2"});const db=a.firestore();
(async()=>{
  const d=await db.collection("bookings").doc("ical_da4300fb231993ece9a16d75f9ca61eb@booking.com").get();
  const x=d.data();
  console.log("checkIn:",x.checkIn,"checkOut:",x.checkOut,"status:",x.status);
  console.log("pendingApproval:",x.pendingApproval,"unverified:",x.unverified);
  console.log("source:",x.source,"propertyId:",x.propertyId);
  process.exit(0);
})();
