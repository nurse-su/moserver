const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// تقديم ملفات الواجهة من مجلد public
app.use(express.static(path.join(__dirname, 'public')));

// رابط MongoDB Atlas
const DEFAULT_MONGO_URI = 'mongodb+srv://sbmsd2020_db_user:WLverdVttU6qoXdK@cluster0.v1vhvuf.mongodb.net/barbershop_db?retryWrites=true&w=majority';
const MONGO_URI = process.env.MONGO_URI || DEFAULT_MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('✔ تم الاتصال بنجاح بمونجو دي بي صالون المروج (barbershop_db)'))
  .catch(err => console.error('❌ خطأ في الاتصال بمونجو دي بي:', err.message));

// ======================= المخططات (Schemas) ======================= //

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, default: 'barber', enum: ['barber', 'manager'] },
  commission: { type: Number, default: 0.5 },
  avatar: String,
  attendance: { 
    status: { type: String, default: 'absent' }, 
    checkIn: { type: String, default: null }, 
    checkOut: { type: String, default: null } 
  }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

const TransactionSchema = new mongoose.Schema({
  txId: { type: String, unique: true, required: true, index: true },
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

const Transaction = mongoose.model('Transaction', TransactionSchema);

// ======================= حقن المدير الافتراضي تلقائياً عند أول اتصال ======================= //
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
      console.log('✔ تم إنشاء حساب المدير (admin / 1234) بنجاح على MongoDB Atlas.');
    }
  } catch (err) {
    console.error('❌ تعذر إنشاء الحسابات الافتراضية:', err.message);
  }
});

// ======================= واجهات برمجة التطبيقات (API) ======================= //

// 0. مسار تسجيل الدخول المباشر من قاعدة البيانات
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const cleanPassword = String(password).trim();

    const user = await User.findOne({ username: cleanUsername }).lean();

    if (!user || String(user.password).trim() !== cleanPassword) {
      return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 1. جلب البيانات الأولية
app.get('/api/initial-data', async (req, res) => {
  try {
    const users = await User.find().lean();
    const transactions = await Transaction.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, users, transactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. تسجيل الفاتورة مع منع التكرار الذري
app.post('/api/transactions', async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) {
      return res.status(400).json({ success: false, error: 'معرّف الفاتورة txId مطلوب' });
    }

    const tx = await Transaction.findOneAndUpdate(
      { txId: txId },
      { $setOnInsert: req.body },
      { upsert: true, new: true }
    );

    res.json({ success: true, transaction: tx });
  } catch (err) {
    if (err.code === 11000) {
      const existingTx = await Transaction.findOne({ txId: req.body.txId });
      return res.json({ success: true, transaction: existingTx, duplicateIgnored: true });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. حذف فاتورة محددة نهائياً (خاص بالمدير)
app.delete('/api/transactions/:txId', async (req, res) => {
  try {
    const { txId } = req.params;
    const deleted = await Transaction.findOneAndDelete({ txId });
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    }
    res.json({ success: true, message: 'تم مسح الفاتورة بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. حذف مستخدم/حلاق نهائياً
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await User.findByIdAndDelete(id);
    res.json({ success: true, message: 'تم حذف الحساب بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. تصفية وحذف فواتير حلاق منفرد بشكل كامل
app.post('/api/transactions/barber-monthly-flush', async (req, res) => {
  try {
    const { barberId } = req.body;
    if (!barberId) {
      return res.status(400).json({ success: false, error: 'معرّف الحلاق مطلوب' });
    }

    // مسح فواتير الحلاق سواء طابقت الـ ID أو اسم الحلاق
    const result = await Transaction.deleteMany({
      $or: [
        { barberId: String(barberId) },
        { barberName: String(barberId) }
      ]
    });

    console.log(`✔ تم حذف ${result.deletedCount} فاتورة للحلاق (${barberId}) بنجاح`);
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('❌ خطأ في مسح فواتير الحلاق:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. تصفية شاملة لجميع فواتير الصالون بالكامل
app.post('/api/transactions/monthly-flush', async (req, res) => {
  try {
    const result = await Transaction.deleteMany({});
    console.log(`✔ تم مسح جميع فواتير الصالون بالكامل (${result.deletedCount} فاتورة)`);
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('❌ خطأ في التصفية الشاملة للصالون:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. اعتماد وتعديل سعر خدمة مع إعادة احتساب الإجمالي بدقة
app.post('/api/transactions/decide-adjustment', async (req, res) => {
  try {
    const { txId, itemIndex, approve, directPrice } = req.body;
    const tx = await Transaction.findOne({ txId });
    if (!tx || !tx.items || !tx.items[itemIndex]) {
      return res.status(404).json({ success: false, error: 'الفاتورة أو الخدمة غير موجودة' });
    }

    if (directPrice !== undefined) {
      tx.items[itemIndex].finalPrice = Number(directPrice);
      tx.items[itemIndex].adjustmentStatus = 'approved';
    } else if (approve) {
      tx.items[itemIndex].finalPrice = Number(tx.items[itemIndex].requestedPrice);
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

    const barber = await User.findById(tx.barberId);
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

// 8. طلب الحلاق لتعديل السعر
app.post('/api/transactions/request-adjustment', async (req, res) => {
  try {
    const { txId, itemIndex, requestedPrice, reason } = req.body;
    const tx = await Transaction.findOne({ txId });
    if (!tx || !tx.items || !tx.items[itemIndex]) {
      return res.status(404).json({ success: false, error: 'الفاتورة أو الخدمة غير موجودة' });
    }

    tx.items[itemIndex].adjustmentStatus = 'pending';
    tx.items[itemIndex].requestedPrice = Number(requestedPrice);
    tx.items[itemIndex].adjustmentReason = reason;
    tx.hasPendingAdjustments = true;

    tx.markModified('items');
    await tx.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. قرار المدير بشأن الدين
app.post('/api/transactions/decide-debt', async (req, res) => {
  try {
    const { txId, approve } = req.body;
    await Transaction.findOneAndUpdate(
      { txId }, 
      { debtStatus: approve ? 'approved' : 'rejected' }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. تسجيل الحضور والانصراف
app.post('/api/attendance', async (req, res) => {
  try {
    const { userId, status, time } = req.body;
    const update = (status === 'present')
      ? { 'attendance.status': 'present', 'attendance.checkIn': time }
      : { 'attendance.status': 'absent', 'attendance.checkOut': time };

    await User.findByIdAndUpdate(userId, update);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. حفظ وتعديل بيانات الحلاق
app.post('/api/users/save', async (req, res) => {
  try {
    const { id, name, username, password, commission, role } = req.body;
    const parsedCommission = (commission !== undefined && !isNaN(commission)) ? Number(commission) : 0.5;

    let savedUser;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      savedUser = await User.findByIdAndUpdate(id, { 
        name, 
        username: username.toLowerCase().trim(), 
        password, 
        commission: parsedCommission, 
        role 
      }, { new: true });
    } else {
      savedUser = await User.create({
        name,
        username: username.toLowerCase().trim(),
        password,
        commission: parsedCommission,
        role,
        avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
        attendance: role === 'barber' ? { status: 'absent', checkIn: null, checkOut: null } : null
      });
    }
    res.json({ success: true, user: savedUser });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. تعديل البروفايل والصورة الشخصية
app.post('/api/users/profile', async (req, res) => {
  try {
    const { userId, username, password, avatar } = req.body;
    const upd = {};
    if (username) upd.username = username.toLowerCase().trim();
    if (password) upd.password = password;
    if (avatar) upd.avatar = avatar;

    await User.findByIdAndUpdate(userId, upd);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// توجيه كل المسارات الأخرى إلى صفحة الواجهة متوافق مع Express 5
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// إعداد المنفذ والاستماع المتوافق مع Render (0.0.0.0)
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 سيرفر صالون المروج يعمل بنجاح على المنفذ: ${PORT}`);
  console.log(`====================================================`);
});