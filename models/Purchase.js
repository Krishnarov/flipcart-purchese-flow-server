import mongoose from 'mongoose';

const purchaseSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationJob',
    required: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  name: { type: String, default: '' },
  productlink: { type: String, default: '' },
  sellername: { type: String, default: '' },
  phone: { type: String, default: '' },
  pincode: { type: String, default: '' },
  addressline1: { type: String, default: '' },
  addressline2: { type: String, default: '' },
  landmark: { type: String, default: '' },
  alternatephone: { type: String, default: '' },
  
  status: {
    type: String,
    enum: ['pending', 'inprogress', 'success', 'failed'],
    default: 'pending'
  },
  screenshot: {
    type: String,
    default: ''
  },
  reason: {
    type: String,
    default: ''
  },
  addressSaved: {
    type: Boolean,
    default: false
  },
  completedAt: {
    type: Date
  }
}, {
  timestamps: true
});

const Purchase = mongoose.model('Purchase', purchaseSchema);
export default Purchase;
