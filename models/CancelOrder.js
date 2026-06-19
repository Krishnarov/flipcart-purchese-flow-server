import mongoose from 'mongoose';

const cancelOrderSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationJob',
    required: true,
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  orderId: {
    type: String,
    required: true,
  },
  reasonvalue: {
    type: String,
  },
  reasontext: {
    type: String,
  },
  seller: {
    type: String,
  },
  status: {
    type: String,
    enum: ['pending', 'inprogress', 'success', 'failed'],
    default: 'pending',
  },
  screenshot: {
    type: String,
  },
  reason: {
    type: String,
  },
}, { timestamps: true });

const CancelOrder = mongoose.model('CancelOrder', cancelOrderSchema);
export default CancelOrder;
