const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();

const express=require('express'),mongoose=require('mongoose'),crypto=require('crypto'),Razorpay=require('razorpay');
const helmet=require('helmet'),rateLimit=require('express-rate-limit'),path=require('path'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
for(const k of ['MONGODB_URI','JWT_SECRET','ADMIN_EMAIL','ADMIN_PASSWORD']){if(!process.env[k]){console.error('Missing env var '+k);process.exit(1)}}
if(process.env.ADMIN_PASSWORD.length<10){console.error('ADMIN_PASSWORD must be at least 10 characters');process.exit(1)}
const ADMIN_HASH=bcrypt.hashSync(process.env.ADMIN_PASSWORD,12);
const app=express();app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'","https://checkout.razorpay.com"],frameSrc:["https://api.razorpay.com","https://checkout.razorpay.com"],imgSrc:["'self'","data:"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],fontSrc:["https://fonts.gstatic.com"],connectSrc:["'self'","https://lumberjack.razorpay.com","https://api.razorpay.com"]}}}));

const Counter=mongoose.model('Counter',new mongoose.Schema({_id:String,seq:Number}));
const Product=mongoose.model('Product',new mongoose.Schema({
 name:{type:String,required:true,maxlength:120},description:{type:String,maxlength:1000,default:''},
 price:{type:Number,required:true,min:1},mrp:{type:Number,min:0,default:0},packSize:{type:String,maxlength:60,default:''},
 ingredients:{type:String,maxlength:400,default:''},image:{type:String,maxlength:700000,default:''},
 stock:{type:Number,min:0,default:0},active:{type:Boolean,default:true}},{timestamps:true}));
const Order=mongoose.model('Order',new mongoose.Schema({
 orderId:{type:String,unique:true,index:true},customer:{name:String,phone:String,address:String},
 items:[{productId:mongoose.Schema.Types.ObjectId,name:String,price:Number,qty:Number}],amount:Number,
 paymentMethod:{type:String,enum:['online','cod']},
 paymentStatus:{type:String,enum:['pending','paid','failed','cod_pending','cod_collected'],default:'pending'},
 orderStatus:{type:String,default:'placed'},razorpayOrderId:String,razorpayPaymentId:String,
 statusHistory:[{status:String,at:{type:Date,default:Date.now}}],
 courierName:String,trackingNumber:String,trackingUrl:String,estimatedDelivery:String,shippingNotes:String,
 otpHash:String,otpExpires:Date,otpTries:{type:Number,default:0}},{timestamps:true}));

const nextId=async()=>{const c=await Counter.findByIdAndUpdate('order',{$inc:{seq:1}},{new:true,upsert:true});return `SULTARA-${new Date().getFullYear()}-${String(c.seq).padStart(5,'0')}`};
const rz=process.env.RAZORPAY_KEY_ID?new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET}):null;
const safeEq=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};

async function reserve(lines){const done=[];for(const l of lines){
 const r=await Product.updateOne({_id:l.product._id,active:true,stock:{$gte:l.qty}},{$inc:{stock:-l.qty}});
 if(r.modifiedCount!==1){await release(done);return false}done.push(l)}return true}
const release=async lines=>{for(const l of lines)await Product.updateOne({_id:l.product._id},{$inc:{stock:l.qty}})};

app.post('/api/payments/webhook',express.raw({type:'application/json'}),async(req,res)=>{
 const exp=crypto.createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET||'').update(req.body).digest('hex');
 if(!safeEq(req.headers['x-razorpay-signature']||'',exp))return res.status(400).end();
 const ev=JSON.parse(req.body.toString());const p=ev.payload&&ev.payload.payment&&ev.payload.payment.entity;
 if(p){const o=await Order.findOne({razorpayOrderId:p.order_id});
  if(o){if(ev.event==='payment.captured'&&o.paymentStatus!=='paid'){o.paymentStatus='paid';o.razorpayPaymentId=p.id;o.orderStatus='confirmed';o.statusHistory.push({status:'payment confirmed'});await o.save()}
   if(ev.event==='payment.failed'&&o.paymentStatus==='pending'){o.paymentStatus='failed';await o.save()}}}
 res.json({ok:true})});

app.use(express.json({limit:'1mb'}));
app.use('/api',rateLimit({windowMs:15*60*1000,max:200}));

// ---------- public ----------
app.get('/api/products',async(req,res)=>{res.json(await Product.find({active:true}).sort({createdAt:1}).lean())});

app.post('/api/orders',async(req,res)=>{let lines=[];let reserved=false;try{
 const {customer,items,method}=req.body||{};
 if(!customer||!customer.name||String(customer.phone||'').replace(/\D/g,'').length<10||String(customer.address||'').length<10||!Array.isArray(items)||!items.length||items.length>20||!['online','cod'].includes(method))
  return res.status(400).json({error:'Please check your details and try again.'});
 for(const it of items){const qty=Number(it.qty);
  if(!mongoose.isValidObjectId(it.productId)||!Number.isInteger(qty)||qty<1||qty>50)return res.status(400).json({error:'Invalid cart.'});
  const product=await Product.findOne({_id:it.productId,active:true});
  if(!product)return res.status(400).json({error:'A product in your cart is no longer available.'});
  lines.push({product,qty})}
 const amount=lines.reduce((s,l)=>s+l.product.price*l.qty,0);
 const o=new Order({orderId:await nextId(),customer:{name:String(customer.name).slice(0,100),phone:String(customer.phone).slice(0,20),address:String(customer.address).slice(0,500)},
  items:lines.map(l=>({productId:l.product._id,name:l.product.name,price:l.product.price,qty:l.qty})),amount,paymentMethod:method,
  paymentStatus:method==='cod'?'cod_pending':'pending',statusHistory:[{status:method==='cod'?'COD order placed':'order placed'}]});
 let rzOrder=null;
 if(method==='online'){if(!rz)return res.status(503).json({error:'Online payment is not configured yet.'});
  rzOrder=await rz.orders.create({amount:amount*100,currency:'INR',receipt:o.orderId});o.razorpayOrderId=rzOrder.id}
 if(!(await reserve(lines)))return res.status(409).json({error:'Sorry, one of the items is out of stock.'});
 reserved=true;await o.save();
 if(method==='online')return res.json({orderId:o.orderId,razorpayOrderId:rzOrder.id,amount:amount*100,keyId:process.env.RAZORPAY_KEY_ID});
 res.json({orderId:o.orderId})
}catch(e){if(reserved)await release(lines);console.error(e);res.status(500).json({error:'Could not place the order. Please try again.'})}});

app.post('/api/payments/verify',async(req,res)=>{try{
 const {orderId,razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
 const o=await Order.findOne({orderId});
 if(!o||o.razorpayOrderId!==razorpay_order_id)return res.status(400).json({error:'Order not found.'});
 const exp=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id+'|'+razorpay_payment_id).digest('hex');
 if(!safeEq(razorpay_signature||'',exp))return res.status(400).json({error:'Payment verification failed.'});
 if(o.paymentStatus!=='paid'){o.paymentStatus='paid';o.razorpayPaymentId=razorpay_payment_id;o.orderStatus='confirmed';o.statusHistory.push({status:'payment confirmed'});await o.save()}
 res.json({ok:true,orderId:o.orderId})
}catch(e){console.error(e);res.status(500).json({error:'Verification error.'})}});

// ---------- admin ----------
app.post('/api/admin/login',rateLimit({windowMs:15*60*1000,max:10,message:{error:'Too many attempts. Try again later.'}}),(req,res)=>{
 const {email,password}=req.body||{};
 const ok=safeEq(String(email||'').toLowerCase(),process.env.ADMIN_EMAIL.toLowerCase())&bcrypt.compareSync(String(password||''),ADMIN_HASH);
 if(!ok)return res.status(401).json({error:'Wrong email or password.'});
 res.json({token:jwt.sign({role:'admin'},process.env.JWT_SECRET,{expiresIn:'8h'})})});
const admin=(req,res,next)=>{try{const t=(req.headers.authorization||'').replace('Bearer ','');
 if(jwt.verify(t,process.env.JWT_SECRET).role!=='admin')throw 0;next()}catch(e){res.status(401).json({error:'Please log in again.'})}};
const pick=b=>({name:String(b.name||'').trim(),description:String(b.description||''),price:Number(b.price),mrp:Number(b.mrp)||0,packSize:String(b.packSize||''),
 ingredients:String(b.ingredients||''),image:String(b.image||''),stock:Math.max(0,parseInt(b.stock)||0),active:b.active!==false});
const okImg=i=>!i||/^data:image\/(jpeg|png|webp);base64,/.test(i)||/^\/[\w.\-]+$/.test(i)||/^https:\/\//.test(i);
const wrap=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){res.status(400).json({error:e.name==='ValidationError'?'Please check the product details.':'Request failed.'})}};

app.get('/api/admin/products',admin,wrap(async(q,r)=>r.json(await Product.find().sort({createdAt:1}).lean())));
app.post('/api/admin/products',admin,wrap(async(q,r)=>{const d=pick(q.body);if(!okImg(d.image))throw 0;r.json(await Product.create(d))}));
app.put('/api/admin/products/:id',admin,wrap(async(q,r)=>{const d=pick(q.body);if(!okImg(d.image))throw 0;
 r.json(await Product.findByIdAndUpdate(q.params.id,d,{new:true,runValidators:true}))}));
app.delete('/api/admin/products/:id',admin,wrap(async(q,r)=>{await Product.findByIdAndDelete(q.params.id);r.json({ok:true})}));
app.get('/api/admin/orders',admin,wrap(async(q,r)=>r.json(await Order.find().select('-otpHash -otpExpires -otpTries').sort({createdAt:-1}).limit(200).lean())));
const STAT=['placed','confirmed','processing','packed','shipped','out_for_delivery','delivered','cancelled'];
app.patch('/api/admin/orders/:id',admin,wrap(async(q,r)=>{const b=q.body,s=b.orderStatus;if(s&&!STAT.includes(s))throw 0;
 const o=await Order.findById(q.params.id);if(!o)throw 0;
 for(const k of ['courierName','trackingNumber','trackingUrl','estimatedDelivery','shippingNotes'])if(typeof b[k]==='string')o[k]=b[k].trim().slice(0,300);
 if(o.trackingUrl&&!/^https:\/\//.test(o.trackingUrl))throw 0;
 if(s&&s!==o.orderStatus){
  if(s==='cancelled')await release(o.items.map(i=>({product:{_id:i.productId},qty:i.qty})));
  o.orderStatus=s;o.statusHistory.push({status:s});
  if(s==='delivered'&&o.paymentMethod==='cod')o.paymentStatus='cod_collected'}
 await o.save();const j=o.toObject();delete j.otpHash;delete j.otpExpires;delete j.otpTries;r.json(j)}));


// ---------- customer order tracking (OTP protected) ----------
const last10=p=>String(p||'').replace(/\D/g,'').slice(-10);
const otpHash=(otp,id)=>crypto.createHash('sha256').update(otp+id+process.env.JWT_SECRET).digest('hex');
async function sendOtp(phone,otp){ // plug in any SMS/WhatsApp provider that accepts a JSON webhook
 const msg=`Your SULTARA order tracking code is ${otp}. It is valid for 10 minutes.`;
 if(process.env.SMS_WEBHOOK_URL){const r=await fetch(process.env.SMS_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(process.env.SMS_WEBHOOK_TOKEN||'')},body:JSON.stringify({phone:'91'+phone,message:msg})});return r.ok}
 if(process.env.NODE_ENV!=='production'){console.log('[DEV ONLY] OTP for '+phone+': '+otp);return true}
 return false}
const trackLimit=rateLimit({windowMs:15*60*1000,max:8,message:{error:'Too many attempts. Please try again later.'}});
app.post('/api/track/request',trackLimit,async(req,res)=>{try{
 const orderId=String(req.body.orderId||'').trim().toUpperCase(),phone=last10(req.body.phone);
 const o=await Order.findOne({orderId});
 if(o&&last10(o.customer.phone)===phone){const otp=String(crypto.randomInt(100000,1000000));
  o.otpHash=otpHash(otp,o.orderId);o.otpExpires=new Date(Date.now()+10*60*1000);o.otpTries=0;await o.save();
  if(!(await sendOtp(phone,otp)))return res.status(503).json({error:'OTP service is not set up yet. Please contact us on WhatsApp.'})}
 res.json({ok:true,message:'If the order ID and phone number match, a 6-digit code has been sent.'})
}catch(e){console.error(e);res.status(500).json({error:'Something went wrong.'})}});
app.post('/api/track/verify',trackLimit,async(req,res)=>{try{
 const orderId=String(req.body.orderId||'').trim().toUpperCase(),otp=String(req.body.otp||'').trim();
 const o=await Order.findOne({orderId});
 if(!o||!o.otpHash||o.otpExpires<new Date()||o.otpTries>=5||!safeEq(otpHash(otp,orderId),o.otpHash)){
  if(o&&o.otpHash){o.otpTries++;await o.save()}
  return res.status(401).json({error:'Wrong or expired code.'})}
 o.otpHash=undefined;o.otpExpires=undefined;await o.save();
 res.json({token:jwt.sign({role:'track',orderId},process.env.JWT_SECRET,{expiresIn:'30m'})})
}catch(e){res.status(500).json({error:'Something went wrong.'})}});
const trackAuth=async(req,res,next)=>{try{const d=jwt.verify((req.headers.authorization||'').replace('Bearer ',''),process.env.JWT_SECRET);
 if(d.role!=='track')throw 0;req.order=await Order.findOne({orderId:d.orderId});if(!req.order)throw 0;next()}catch(e){res.status(401).json({error:'Please verify again.'})}};
const view=o=>({orderId:o.orderId,createdAt:o.createdAt,updatedAt:o.updatedAt,customerName:o.customer.name,address:o.customer.address,items:o.items,amount:o.amount,
 paymentMethod:o.paymentMethod,paymentStatus:o.paymentStatus,orderStatus:o.orderStatus,statusHistory:o.statusHistory,courierName:o.courierName,trackingNumber:o.trackingNumber,
 trackingUrl:o.trackingUrl,estimatedDelivery:o.estimatedDelivery,shippingNotes:o.shippingNotes});
app.get('/api/track/order',trackAuth,(req,res)=>res.json(view(req.order)));
app.post('/api/track/cancel',trackAuth,async(req,res)=>{const o=req.order;
 if(o.paymentMethod!=='cod'||!['placed','confirmed'].includes(o.orderStatus))return res.status(400).json({error:'This order cannot be cancelled online. Please contact us on WhatsApp.'});
 await release(o.items.map(i=>({product:{_id:i.productId},qty:i.qty})));o.orderStatus='cancelled';o.statusHistory.push({status:'cancelled by customer'});await o.save();res.json(view(o))});
app.get('/track-order',(q,r)=>r.sendFile(path.join(__dirname,'public','tracking.html')));
app.use(express.static(path.join(__dirname,'public')));
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected");

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`SULTARA running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });
