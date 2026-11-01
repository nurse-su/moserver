'use strict';

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI;

mongoose.set('strictQuery', true);

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, unique: true, required: true, lowercase: true, trim: true },
  // ملاحظة: ترحيل كلمات المرور إلى bcrypt مطلوب قبل تشغيل النظام على الإنترنت.
  password: { type: String, required: true, select: true },
  role: { type: String, default: 'barber', enum: ['barber', 'manager'] },
  commission: { type: Number, default: 0.5, min: 0, max: 1 },
  avatar: String,
  attendance: {
    status: { type: String, default: 'absent' },
    checkIn: { type: String, default: null },
    checkOut: { type: String, default: null }
  }
}, { timestamps: true });

const TransactionSchema = new mongoose.Schema({
  txId: { type: String, unique: true, required: true, index: true, trim: true },
  barberId: { type: String, required: true, index: true },
  barberName: String,
  clientName: String,
  paymentMethod: { type: String, default: 'كاش (نقداً)' },
  isDebt: { type: Boolean, default: false },
  debtStatus: { type: String, default: 'approved' },
  date: { type: String, index: true },
  time: String,
  items: { type: [mongoose.Schema.Types.Mixed], default: [] },
  totalAmount: { type: Number, default: 0 },
  barberShare: { type: Number, default: 0 },
  salonShare: { type: Number, default: 0 },
  hasPendingAdjustments: { type: Boolean, default: false }
}, { timestamps: true, strict: true });

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

function managerOnly(req, res, next) {
  // لا توجد مصادقة جلسات/رموز في نسخة الواجهة الحالية؛ لذلك نغلق العمليات الحساسة بدلاً من الثقة بدور يرسله المتصفح.
  return res.status(403).json({
    success: false,
    error: 'هذه العملية الحساسة معطلة حتى إضافة مصادقة مدير آمنة من جهة الخادم.'
  });
}

app.get('/api/health', (req, res) => {
  res.json({ success: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    if (!username || !password) return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    const user = await User.findOne({ username }).lean();
    if (!user || String(user.password).trim() !== password) {
      return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    // لا نعيد كلمة المرور إلى المتصفح.
    delete user.password;
    res.json({ success: true, user });
  } catch (err) {
    console.error('login:', err);
    res.status(500).json({ success: false, message: 'تعذر تسجيل الدخول' });
  }
});

app.get('/api/initial-data', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ success: false, error: 'قاعدة البيانات غير متصلة' });
    const [users, transactions] = await Promise.all([
      User.find().select('-password').lean(),
      // لا يوجد limit(100): جلب كل السجلات حتى لا تختفي الفواتير القديمة من التقارير.
      Transaction.find().sort({ createdAt: -1 }).lean()
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, users, transactions, transactionCount: transactions.length });
  } catch (err) {
    console.error('initial-data:', err);
    res.status(500).json({ success: false, error: 'فشل تحميل بيانات قاعدة البيانات' });
  }
});

app.post('/api/transactions', async (req, res) => {
  try {
    const body = req.body || {};
    const txId = String(body.txId || '').trim();
    const barberId = String(body.barberId || '').trim();
    if (!txId || !barberId) return res.status(400).json({ success: false, error: 'txId و barberId مطلوبان' });
    if (!Array.isArray(body.items) || body.items.length === 0) return res.status(400).json({ success: false, error: 'يجب أن تحتوي الفاتورة على خدمة واحدة على الأقل' });
    const totalAmount = Number(body.totalAmount);
    if (!Number.isFinite(totalAmount) || totalAmount < 0) return res.status(400).json({ success: false, error: 'قيمة الفاتورة غير صحيحة' });

    const safe = {
      txId, barberId,
      barberName: String(body.barberName || ''),
      clientName: String(body.clientName || ''),
      paymentMethod: String(body.paymentMethod || 'كاش (نقداً)'),
      isDebt: Boolean(body.isDebt),
      debtStatus: String(body.debtStatus || 'approved'),
      date: String(body.date || new Date().toISOString().slice(0, 10)),
      time: String(body.time || ''),
      items: body.items,
      totalAmount,
      barberShare: Number(body.barberShare || 0),
      salonShare: Number(body.salonShare || 0),
      hasPendingAdjustments: Boolean(body.hasPendingAdjustments)
    };
    const transaction = await Transaction.findOneAndUpdate(
      { txId },
      { $setOnInsert: safe },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    res.status(200).json({ success: true, transaction });
  } catch (err) {
    console.error('save transaction:', err);
    if (err.code === 11000) {
      const existing = await Transaction.findOne({ txId: req.body.txId }).lean();
      if (existing) return res.json({ success: true, transaction: existing, duplicateIgnored: true });
    }
    res.status(500).json({ success: false, error: 'لم يتم حفظ الفاتورة في قاعدة البيانات' });
  }
});

// الحذف النهائي والتصفير مغلقان عمداً. لا نسمح لأي طلب متصفح بمسح السجلات.
app.delete('/api/transactions/:txId', managerOnly);
app.delete('/api/users/:id', managerOnly);
app.post('/api/transactions/barber-monthly-flush', managerOnly);
app.post('/api/transactions/monthly-flush', managerOnly);

app.post('/api/transactions/decide-adjustment', async (req, res) => {
  try {
    const { txId, itemIndex, approve, directPrice } = req.body;
    const tx = await Transaction.findOne({ txId });
    if (!tx || !tx.items || !tx.items[itemIndex]) return res.status(404).json({ success: false, error: 'الفاتورة أو الخدمة غير موجودة' });
    if (directPrice !== undefined) {
      const price = Number(directPrice);
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ success: false, error: 'السعر غير صحيح' });
      tx.items[itemIndex].finalPrice = price;
      tx.items[itemIndex].adjustmentStatus = 'approved';
    } else if (approve) {
      tx.items[itemIndex].finalPrice = Number(tx.items[itemIndex].requestedPrice || 0);
      tx.items[itemIndex].adjustmentStatus = 'approved';
    } else tx.items[itemIndex].adjustmentStatus = 'rejected';
    let total = 0, pending = false;
    tx.items.forEach(item => { total += Number(item.finalPrice || 0); if (item.adjustmentStatus === 'pending') pending = true; });
    const barber = await User.findById(tx.barberId);
    const commission = Number.isFinite(barber?.commission) ? barber.commission : 0.5;
    tx.totalAmount = total;
    tx.barberShare = Math.round(total * commission);
    tx.salonShare = total - tx.barberShare;
    tx.hasPendingAdjustments = pending;
    tx.markModified('items');
    await tx.save();
    res.json({ success: true, transaction: tx });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: 'تعذر اعتماد تعديل السعر' }); }
});

app.post('/api/transactions/request-adjustment', async (req, res) => {
  try {
    const { txId, itemIndex, requestedPrice, reason } = req.body;
    const price = Number(requestedPrice);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ success: false, error: 'السعر المطلوب غير صحيح' });
    const tx = await Transaction.findOne({ txId });
    if (!tx || !tx.items || !tx.items[itemIndex]) return res.status(404).json({ success: false, error: 'الفاتورة أو الخدمة غير موجودة' });
    tx.items[itemIndex].adjustmentStatus = 'pending';
    tx.items[itemIndex].requestedPrice = price;
    tx.items[itemIndex].adjustmentReason = String(reason || '');
    tx.hasPendingAdjustments = true;
    tx.markModified('items');
    await tx.save();
    res.json({ success: true, transaction: tx });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: 'تعذر إرسال طلب تعديل السعر' }); }
});

app.post('/api/transactions/decide-debt', async (req, res) => {
  try {
    const { txId, approve } = req.body;
    const updated = await Transaction.findOneAndUpdate({ txId }, { debtStatus: approve ? 'approved' : 'rejected' }, { new: true });
    if (!updated) return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    res.json({ success: true, transaction: updated });
  } catch (err) { res.status(500).json({ success: false, error: 'تعذر تحديث حالة الدين' }); }
});

app.post('/api/attendance', async (req, res) => {
  try {
    const { userId, status, time } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, error: 'معرف المستخدم غير صحيح' });
    const update = status === 'present'
      ? { 'attendance.status': 'present', 'attendance.checkIn': time, 'attendance.checkOut': null }
      : { 'attendance.status': 'absent', 'attendance.checkOut': time };
    const user = await User.findByIdAndUpdate(userId, update, { new: true });
    if (!user) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'تعذر تسجيل الحضور' }); }
});

app.post('/api/users/save', async (req, res) => {
  try {
    const { id, name, username, password, commission, role } = req.body;
    if (!name || !username) return res.status(400).json({ success: false, error: 'الاسم واسم المستخدم مطلوبان' });
    const cleanUsername = String(username).trim().toLowerCase();
    const data = { name: String(name).trim(), username: cleanUsername, commission: Number.isFinite(Number(commission)) ? Number(commission) : 0.5, role: role === 'manager' ? 'manager' : 'barber' };
    if (password) data.password = String(password);
    let user;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      user = await User.findByIdAndUpdate(id, data, { new: true, runValidators: true }).select('-password');
      if (!user) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    } else {
      if (!password) return res.status(400).json({ success: false, error: 'كلمة المرور مطلوبة للحساب الجديد' });
      user = await User.create({ ...data, avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150', attendance: data.role === 'barber' ? { status: 'absent', checkIn: null, checkOut: null } : undefined });
      user = user.toObject(); delete user.password;
    }
    res.json({ success: true, user });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, error: 'اسم المستخدم مستخدم بالفعل' });
    console.error(err); res.status(500).json({ success: false, error: 'تعذر حفظ بيانات المستخدم' });
  }
});

app.post('/api/users/profile', async (req, res) => {
  try {
    const { userId, username, password, avatar } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ success: false, error: 'معرف المستخدم غير صحيح' });
    const update = {};
    if (username) update.username = String(username).trim().toLowerCase();
    if (password) update.password = String(password);
    if (avatar) update.avatar = String(avatar);
    const user = await User.findByIdAndUpdate(userId, update, { new: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ success: false, error: 'تعذر تحديث الملف الشخصي' }); }
});

app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'مسار API غير موجود' }));
app.get('/*splat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  if (!MONGO_URI) throw new Error('MONGO_URI غير موجود في ملف البيئة .env');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('✔ تم الاتصال بقاعدة MongoDB');
  await Promise.all([User.init(), Transaction.init()]);
  app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Barber salon server listening on ${PORT}`));
}

start().catch(err => {
  console.error('❌ لم يبدأ السيرفر لأن الاتصال بقاعدة البيانات فشل:', err.message);
  process.exit(1);
});
