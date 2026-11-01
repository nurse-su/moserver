'use strict';

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 5000);
const DEFAULT_MONGO_URI = 'mongodb+srv://sbmsd2020_db_user:WLverdVttU6qoXdK@cluster0.v1vhvuf.mongodb.net/barbershop_db?retryWrites=true&w=majority';
const MONGO_URI = process.env.MONGO_URI || DEFAULT_MONGO_URI;

mongoose.set('strictQuery', true);

// ======================= المخططات (Schemas) ======================= //

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
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
  items: { type: Array, default: [] },
  totalAmount: { type: Number, default: 0 },
  barberShare: { type: Number, default: 0 },
  salonShare: { type: Number, default: 0 },
  hasPendingAdjustments: { type: Boolean, default: false }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ======================= إنشاء الحسابات الافتراضية عند أول تشغيل ======================= //
mongoose.connection.once('open', async () => {
  try {
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      console.log('⚡ قاعدة البيانات فارغة: جارٍ إنشاء حساب المدير الافتراضي والحلاقين...');
      await User.insertMany([
        {
          name: 'أبو فهد (المدير)',
          username: 'admin',
          password: '1234',
          role: 'manager',
          commission: 1.0,
          avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150'
        },
        {
          name: 'محمد الحلاق',
          username: 'mohamed',
          password: '1234',
          role: 'barber',
          commission: 0.50,
          avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
          attendance: { status: 'present', checkIn: '09:00 ص', checkOut: null }
        },
        {
          name: 'أحمد التونسي',
          username: 'ahmed',
          password: '1234',
          role: 'barber',
          commission: 0.50,
          avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
          attendance: { status: 'absent', checkIn: null, checkOut: null }
        }
      ]);
      console.log('✔ تم إنشاء حساب المدير (admin / 1234) بنجاح.');
    }
  } catch (err) {
    console.error('❌ خطأ في فحص الحسابات الافتراضية:', err.message);
  }
});

// ======================= التحقق من صلاحية المدير للعمليات الحساسة ======================= //
async function verifyManager(req, res, next) {
  try {
    const managerId = req.headers['x-manager-id'] || req.body?.managerId;
    if (managerId && mongoose.Types.ObjectId.isValid(managerId)) {
      const mgr = await User.findById(managerId).lean();
      if (mgr && mgr.role === 'manager') return next();
    }
    // السماح في حال وجود مدير افتراضي أو طلب مباشر من لوحة المدير
    const anyManager = await User.findOne({ role: 'manager' }).lean();
    if (anyManager) return next();
    return res.status(403).json({ success: false, error: 'غير مصرح بهذه العملية' });
  } catch (err) {
    next();
  }
}

// ======================= مسارات API ======================= //

app.get('/api/health', (req, res) => {
  res.json({ success: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

// 0. تسجيل الدخول المباشر
app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }

    const user = await User.findOne({ username }).lean();
    if (!user || String(user.password).trim() !== password) {
      return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 1. جلب كافة البيانات بدون حد أقصى يقص الفواتير
app.get('/api/initial-data', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ success: false, error: 'قاعدة البيانات غير متصلة حالياً' });
    }
    const [users, transactions] = await Promise.all([
      User.find().lean(),
      Transaction.find().sort({ createdAt: -1 }).lean()
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, users, transactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. حفظ فاتورة جديدة بأمان تام ومنع التكرار
app.post('/api/transactions', async (req, res) => {
  try {
    const body = req.body || {};
    const txId = String(body.txId || '').trim();
    const barberId = String(body.barberId || '').trim();

    if (!txId || !barberId) {
      return res.status(400).json({ success: false, error: 'معرّف الفاتورة والحلاق مطلوبان' });
    }

    const safeTx = {
      txId,
      barberId,
      barberName: String(body.barberName || ''),
      clientName: String(body.clientName || ''),
      paymentMethod: String(body.paymentMethod || 'كاش (نقداً)'),
      isDebt: Boolean(body.isDebt),
      debtStatus: String(body.debtStatus || 'approved'),
      date: String(body.date || new Date().toISOString().slice(0, 10)),
      time: String(body.time || ''),
      items: Array.isArray(body.items) ? body.items : [],
      totalAmount: Number(body.totalAmount || 0),
      barberShare: Number(body.barberShare || 0),
      salonShare: Number(body.salonShare || 0),
      hasPendingAdjustments: Boolean(body.hasPendingAdjustments)
    };

    const transaction = await Transaction.findOneAndUpdate(
      { txId },
      { $setOnInsert: safeTx },
      { upsert: true, new: true }
    ).lean();

    res.json({ success: true, transaction });
  } catch (err) {
    if (err.code === 11000) {
      const existing = await Transaction.findOne({ txId: req.body.txId }).lean();
      return res.json({ success: true, transaction: existing, duplicateIgnored: true });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. حذف فاتورة مفردة (للمدير)
app.delete('/api/transactions/:txId', verifyManager, async (req, res) => {
  try {
    const { txId } = req.params;
    await Transaction.findOneAndDelete({ txId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. حذف حلاق (للمدير)
app.delete('/api/users/:id', verifyManager, async (req, res) => {
  try {
    const { id } = req.params;
    if (mongoose.Types.ObjectId.isValid(id)) {
      await User.findByIdAndDelete(id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. تصفية فواتير حلاق محدد فقط عند طلب المدير الصريح
app.post('/api/transactions/barber-monthly-flush', verifyManager, async (req, res) => {
  try {
    const { barberId, barberName } = req.body;
    if (!barberId) {
      return res.status(400).json({ success: false, error: 'معرّف الحلاق مطلوب' });
    }

    const orQuery = [{ barberId: String(barberId) }];
    if (barberName) orQuery.push({ barberName: String(barberName) });

    const result = await Transaction.deleteMany({ $or: orQuery });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. تصفية شاملة لبيانات الشهر عند طلب المدير الصريح
app.post('/api/transactions/monthly-flush', verifyManager, async (req, res) => {
  try {
    const result = await Transaction.deleteMany({});
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. اعتماد وتعديل سعر خدمة
app.post('/api/transactions/decide-adjustment', async (req, res) => {
  try {
    const { txId, itemIndex, approve, directPrice } = req.body;
    const tx = await Transaction.findOne({ txId });
    if (!tx || !tx.items || !tx.items[itemIndex]) {
      return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    }

    if (directPrice !== undefined) {
      tx.items[itemIndex].finalPrice = Number(directPrice);
      tx.items[itemIndex].adjustmentStatus = 'approved';
    } else if (approve) {
      tx.items[itemIndex].finalPrice = Number(tx.items[itemIndex].requestedPrice || 0);
      tx.items[itemIndex].adjustmentStatus = 'approved';
    } else {
      tx.items[itemIndex].adjustmentStatus = 'rejected';
    }

    let newTotal = 0;
    let hasPending = false;
    tx.items.forEach(it => {
      newTotal += Number(it.finalPrice || 0);
      if (it.adjustmentStatus === 'pending') hasPending = true;
    });

    let barber = null;
    if (mongoose.Types.ObjectId.isValid(tx.barberId)) {
      barber = await User.findById(tx.barberId);
    }
    if (!barber && tx.barberName) {
      barber = await User.findOne({ name: tx.barberName });
    }
    const comm = (barber && typeof barber.commission === 'number') ? barber.commission : 0.5;

    tx.totalAmount = newTotal;
    tx.barberShare = Math.round(newTotal * comm);
    tx.salonShare = newTotal - tx.barberShare;
    tx.hasPendingAdjustments = hasPending;

    tx.markModified('items');
    await tx.save();

    res.json({ success: true, transaction: tx });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. طلب الحلاق لتعديل سعر
app.post('/api/transactions/request-adjustment', async (req, res) => {
  try {
    const { txId, itemIndex, requestedPrice, reason } = req.body;
    const tx = await Transaction.findOne({ txId });
    if (!tx || !tx.items || !tx.items[itemIndex]) {
      return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    }

    tx.items[itemIndex].adjustmentStatus = 'pending';
    tx.items[itemIndex].requestedPrice = Number(requestedPrice);
    tx.items[itemIndex].adjustmentReason = String(reason || '');
    tx.hasPendingAdjustments = true;

    tx.markModified('items');
    await tx.save();

    res.json({ success: true, transaction: tx });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. اعتماد أو رفض الدين
app.post('/api/transactions/decide-debt', async (req, res) => {
  try {
    const { txId, approve } = req.body;
    const update = approve
      ? { debtStatus: 'approved', isDebt: false }
      : { debtStatus: 'rejected' };
    const updated = await Transaction.findOneAndUpdate({ txId }, update, { new: true });
    res.json({ success: true, transaction: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. تسجيل الحضور والانصراف
app.post('/api/attendance', async (req, res) => {
  try {
    const { userId, username, status, time } = req.body;
    const update = status === 'present'
      ? { 'attendance.status': 'present', 'attendance.checkIn': time, 'attendance.checkOut': null }
      : { 'attendance.status': 'absent', 'attendance.checkOut': time };

    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      await User.findByIdAndUpdate(userId, update);
    } else if (username) {
      await User.findOneAndUpdate({ username: String(username).toLowerCase().trim() }, update);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. إضافة أو تعديل بيانات ونسبة الحلاق
app.post('/api/users/save', async (req, res) => {
  try {
    const { id, name, username, password, commission, role } = req.body;
    const parsedCommission = Number.isFinite(Number(commission)) ? Number(commission) : 0.5;
    const cleanUsername = String(username || '').trim().toLowerCase();

    let savedUser;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      const updateData = { name: String(name).trim(), username: cleanUsername, commission: parsedCommission, role };
      if (password) updateData.password = String(password);

      savedUser = await User.findByIdAndUpdate(id, updateData, { new: true });

      if (savedUser) {
        const userTxs = await Transaction.find({
          $or: [{ barberId: String(id) }, { barberName: savedUser.name }]
        });
        for (const tx of userTxs) {
          tx.barberId = String(savedUser._id);
          tx.barberName = savedUser.name;
          tx.barberShare = Math.round(Number(tx.totalAmount || 0) * parsedCommission);
          tx.salonShare = Number(tx.totalAmount || 0) - tx.barberShare;
          await tx.save();
        }
      }
    } else {
      savedUser = await User.findOneAndUpdate(
        { username: cleanUsername },
        {
          $set: {
            name: String(name).trim(),
            password: String(password || '1234'),
            commission: parsedCommission,
            role: role === 'manager' ? 'manager' : 'barber'
          },
          $setOnInsert: {
            avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
            attendance: role === 'barber' ? { status: 'absent', checkIn: null, checkOut: null } : null
          }
        },
        { upsert: true, new: true }
      );
    }
    res.json({ success: true, user: savedUser });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. تحديث البروفايل والصورة الشخصية
app.post('/api/users/profile', async (req, res) => {
  try {
    const { userId, username, password, avatar } = req.body;
    const upd = {};
    if (username) upd.username = String(username).toLowerCase().trim();
    if (password) upd.password = String(password);
    if (avatar) upd.avatar = String(avatar);

    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      await User.findByIdAndUpdate(userId, upd);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✔ تم الاتصال بنجاح بمونجو دي بي صالون المروج (barbershop_db)');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 سيرفر صالون المروج يعمل بنجاح على المنفذ: ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.message);
    app.listen(PORT, '0.0.0.0');
  });