import mongoose from 'mongoose';

const loginEmailSchema = new mongoose.Schema({
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
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending'
  },
  reason: {
    type: String,
    default: ''
  },
  screenshot: {
    type: String,
    default: ''
  },
  cookies: {
    type: mongoose.Schema.Types.Mixed,
    default: []
  },
  localStorage: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  sessionStorage: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

const LoginEmail = mongoose.model('LoginEmail', loginEmailSchema);
export default LoginEmail;
