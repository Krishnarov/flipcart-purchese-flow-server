import mongoose from 'mongoose';

const automationJobSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  uploadedFile: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['login', 'purchase', 'cancel'],
    default: 'purchase'
  },
  status: {
    type: String,
    enum: ['idle', 'pending', 'running', 'completed', 'failed', 'stopped'],
    default: 'idle'
  },
  reason: {
    type: String,
    default: ''
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  }
}, {
  timestamps: true
});

const AutomationJob = mongoose.model('AutomationJob', automationJobSchema);
export default AutomationJob;
