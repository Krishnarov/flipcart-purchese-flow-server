import express from 'express';
import multer from 'multer';
import * as xlsx from 'xlsx';
import { requireAuth } from '../middleware/auth.js';
import AutomationJob from '../models/AutomationJob.js';
import Purchase from '../models/Purchase.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

const getFieldValue = (row, possibleKeys) => {
  for (const key of Object.keys(row)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const pKey of possibleKeys) {
      if (normalizedKey === pKey) {
        return row[key] ? row[key].toString().trim() : '';
      }
    }
  }
  return '';
};

// --- Helper for Pagination, Search, and Date Filtering ---
const buildMatchQuery = (req, baseQuery = {}) => {
  const { search, startDate, endDate } = req.query;
  const match = { ...baseQuery };

  if (search) {
    match.$or = [
      { uploadedFile: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { reason: { $regex: search, $options: 'i' } },
      { status: { $regex: search, $options: 'i' } },
      { sellername: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { name: { $regex: search, $options: 'i' } }
    ];
  }

  // Date Filtering
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  return match;
};

// @route   POST api/purchases/upload
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Please upload an Excel file' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = xlsx.utils.sheet_to_json(worksheet);

    if (jsonData.length === 0) return res.status(400).json({ success: false, message: 'The Excel sheet is empty' });

    const parsedRecords = [];
    for (let i = 0; i < jsonData.length; i++) {
      const row = jsonData[i];
      const email = getFieldValue(row, ['email', 'emailid', 'mail', 'emailaddress', 'emails']);
      if (email) {
        parsedRecords.push({
          email: email.toLowerCase(),
          name: getFieldValue(row, ['name', 'fullname', 'customername', 'buyername']),
          productlink: getFieldValue(row, ['productlink', 'link', 'url', 'producturl']),
          sellername: getFieldValue(row, ['sellername', 'seller', 'vendor']),
          phone: getFieldValue(row, ['phone', 'phonenumber', 'mobile', 'contact']),
          pincode: getFieldValue(row, ['pincode', 'pin', 'zip', 'zipcode', 'postalcode']),
          addressline1: getFieldValue(row, ['addressline1', 'address1', 'add1', 'address']),
          addressline2: getFieldValue(row, ['addressline2', 'address2', 'add2']),
          landmark: getFieldValue(row, ['landmark', 'near']),
          alternatephone: getFieldValue(row, ['alternatephone', 'altphone', 'alternate', 'altmobile'])
        });
      }
    }

    if (parsedRecords.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid records with email addresses could be detected.' });
    }

    // Sort by email so same emails are grouped together sequentially
    parsedRecords.sort((a, b) => a.email.localeCompare(b.email));

    const job = new AutomationJob({
      userId: req.user._id,
      uploadedFile: req.file.originalname,
      type: 'purchase',
      status: 'idle',
      reason: 'Ready to start...'
    });
    await job.save();

    const dbRecords = parsedRecords.map(record => ({
      jobId: job._id,
      ...record,
      status: 'pending'
    }));
    const savedRecords = await Purchase.insertMany(dbRecords);

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'new-job', jobId: job._id });

    return res.status(200).json({
      success: true,
      message: `Successfully uploaded "${req.file.originalname}". Created job with ${savedRecords.length} records.`,
      jobId: job._id,
      count: savedRecords.length
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Error processing Excel file' });
  }
});

// @route   GET api/purchases/stats
// @desc    Get unpaginated global stats
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const jobsCount = await AutomationJob.countDocuments({ userId: req.user._id, isDeleted: false, type: 'purchase' });
    const activeJobs = await AutomationJob.find({ userId: req.user._id, isDeleted: false, type: 'purchase' }, '_id status');
    
    let runningCount = 0;
    const jobIds = activeJobs.map(j => {
      if (j.status === 'running' || j.status === 'pending') runningCount++;
      return j._id;
    });
    
    const recordStats = await Purchase.aggregate([
      { $match: { jobId: { $in: jobIds } } },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        success: { $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } }
      }}
    ]);

    const stats = recordStats.length > 0 ? recordStats[0] : { total: 0, success: 0, failed: 0, pending: 0 };
    
    return res.status(200).json({
      success: true,
      stats: {
        jobs: jobsCount,
        runningJobs: runningCount,
        total: stats.total,
        success: stats.success,
        failed: stats.failed,
        pending: stats.pending
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching stats' });
  }
});

// @route   GET api/purchases/files
// @desc    Get server-side paginated automation jobs
router.get('/files', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    const matchQuery = buildMatchQuery(req, { userId: req.user._id, isDeleted: false, type: 'purchase' });
    delete matchQuery.$or;
    if (req.query.search) {
      matchQuery.$or = [
        { uploadedFile: { $regex: req.query.search, $options: 'i' } },
        { status: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const totalRecords = await AutomationJob.countDocuments(matchQuery);

    const jobsList = await AutomationJob.aggregate([
      { $match: matchQuery },
      { $sort: { [sortField]: sortOrder } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'purchases',
          localField: '_id',
          foreignField: 'jobId',
          as: 'records'
        }
      },
      {
        $project: {
          _id: 1, uploadedFile: 1, status: 1, reason: 1, createdAt: 1,
          totalRecords: { $size: "$records" },
          successCount: { $size: { $filter: { input: "$records", as: "e", cond: { $eq: ["$$e.status", "success"] } } } },
          failedCount: { $size: { $filter: { input: "$records", as: "e", cond: { $eq: ["$$e.status", "failed"] } } } },
          pendingCount: { $size: { $filter: { input: "$records", as: "e", cond: { $eq: ["$$e.status", "pending"] } } } }
        }
      }
    ]);

    const formattedJobs = jobsList.map(job => {
      const total = job.totalRecords || 0;
      return {
        ...job,
        successPercentage: total > 0 ? Math.round((job.successCount / total) * 100) : 0,
        failedPercentage: total > 0 ? Math.round((job.failedCount / total) * 100) : 0
      };
    });

    return res.status(200).json({
      success: true,
      data: formattedJobs,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      currentPage: page
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching uploaded jobs list' });
  }
});

// @route   GET api/purchases/file-details
router.get('/file-details', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID parameter is required' });

    const job = await AutomationJob.findOne({ _id: jobId, userId: req.user._id, isDeleted: false });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || '';
    const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

    const matchQuery = buildMatchQuery(req, { jobId: job._id });
    delete matchQuery.$or;
    if (req.query.search) {
      matchQuery.$or = [
        { email: { $regex: req.query.search, $options: 'i' } },
        { status: { $regex: req.query.search, $options: 'i' } },
        { reason: { $regex: req.query.search, $options: 'i' } },
        { sellername: { $regex: req.query.search, $options: 'i' } },
        { phone: { $regex: req.query.search, $options: 'i' } },
        { name: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const sortParams = {};
    if (sortField) {
      sortParams[sortField] = sortOrder;
    }
    sortParams._id = 1;

    const totalRecordsCount = await Purchase.countDocuments(matchQuery);
    const records = await Purchase.find(matchQuery).sort(sortParams).skip(skip).limit(limit);

    // Global counts
    const allRecords = await Purchase.find({ jobId: job._id }, 'status');
    const total = allRecords.length;
    const success = allRecords.filter(e => e.status === 'success').length;
    const failed = allRecords.filter(e => e.status === 'failed').length;
    const pending = allRecords.filter(e => e.status === 'pending').length;

    return res.status(200).json({
      success: true,
      jobId: job._id,
      fileName: job.uploadedFile,
      jobStatus: job.status,
      jobReason: job.reason,
      jobCompletedAt: job.completedAt,
      globalTotal: total,
      successCount: success,
      failedCount: failed,
      pendingCount: pending,
      successPercentage: total > 0 ? Math.round((success / total) * 100) : 0,
      failedPercentage: total > 0 ? Math.round((failed / total) * 100) : 0,
      data: records,
      totalRecords: totalRecordsCount,
      totalPages: Math.ceil(totalRecordsCount / limit),
      currentPage: page
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching job details' });
  }
});

// @route   GET api/purchases/trash
router.get('/trash', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || 'deletedAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    const matchQuery = buildMatchQuery(req, { userId: req.user._id, isDeleted: true, type: 'purchase' });
    delete matchQuery.$or;
    if (req.query.search) {
      matchQuery.$or = [
        { uploadedFile: { $regex: req.query.search, $options: 'i' } },
        { status: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const totalRecords = await AutomationJob.countDocuments(matchQuery);

    const trashedJobs = await AutomationJob.aggregate([
      { $match: matchQuery },
      { $sort: { [sortField]: sortOrder } },
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'purchases', localField: '_id', foreignField: 'jobId', as: 'records' } },
      { $project: {
          _id: 1, uploadedFile: 1, status: 1, reason: 1, createdAt: 1, deletedAt: 1,
          totalRecords: { $size: '$records' },
          successCount: { $size: { $filter: { input: '$records', as: 'e', cond: { $eq: ['$$e.status', 'success'] } } } }
      }}
    ]);

    return res.status(200).json({ 
      success: true, 
      data: trashedJobs,
      totalRecords,
      totalPages: Math.ceil(totalRecords / limit),
      currentPage: page 
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching trash' });
  }
});

// @route   GET api/purchases/export
router.get('/export', requireAuth, async (req, res) => {
  try {
    const { type, jobId, search, startDate, endDate } = req.query;
    
    let dataToExport = [];
    let fileName = 'export.xlsx';

    if (type === 'files' || type === 'trash') {
      const isDeleted = type === 'trash';
      const matchQuery = { userId: req.user._id, isDeleted, type: 'purchase' };
      if (search) {
        matchQuery.$or = [
          { uploadedFile: { $regex: search, $options: 'i' } },
          { status: { $regex: search, $options: 'i' } }
        ];
      }
      if (startDate || endDate) {
        matchQuery.createdAt = {};
        if (startDate) matchQuery.createdAt.$gte = new Date(startDate);
        if (endDate) matchQuery.createdAt.$lte = new Date(endDate);
      }

      const jobsList = await AutomationJob.aggregate([
        { $match: matchQuery },
        { $sort: { createdAt: -1 } },
        { $lookup: { from: 'purchases', localField: '_id', foreignField: 'jobId', as: 'records' } },
        { $project: {
            uploadedFile: 1, status: 1, reason: 1, createdAt: 1, deletedAt: 1,
            totalRecords: { $size: "$records" },
            successCount: { $size: { $filter: { input: "$records", as: "e", cond: { $eq: ["$$e.status", "success"] } } } },
            failedCount: { $size: { $filter: { input: "$records", as: "e", cond: { $eq: ["$$e.status", "failed"] } } } }
        }}
      ]);

      dataToExport = jobsList.map(j => ({
        'Job Name': j.uploadedFile,
        'Status': j.status,
        'Reason': j.reason,
        'Total Records': j.totalRecords,
        'Success': j.successCount,
        'Failed': j.failedCount,
        'Created At': new Date(j.createdAt).toLocaleString(),
        ...(isDeleted ? { 'Deleted At': new Date(j.deletedAt).toLocaleString() } : {})
      }));
      fileName = isDeleted ? 'Trash_Export.xlsx' : 'Automation_Jobs_Export.xlsx';

    } else if (type === 'details') {
      if (!jobId) return res.status(400).json({ success: false, message: 'Job ID missing' });
      const job = await AutomationJob.findOne({ _id: jobId, userId: req.user._id });
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

      const matchQuery = { jobId: job._id };
      if (search) {
        matchQuery.$or = [
          { email: { $regex: search, $options: 'i' } },
          { status: { $regex: search, $options: 'i' } },
          { reason: { $regex: search, $options: 'i' } },
          { sellername: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } },
          { name: { $regex: search, $options: 'i' } }
        ];
      }
      const records = await Purchase.find(matchQuery).sort({ createdAt: 1 });
      
      dataToExport = records.map(e => ({
        'Email Address': e.email,
        'Product Link': e.productlink,
        'Seller Name': e.sellername,
        'Phone': e.phone,
        'Pincode': e.pincode,
        'Address Line 1': e.addressline1,
        'Address Line 2': e.addressline2,
        'Landmark': e.landmark,
        'Alternate Phone': e.alternatephone,
        'Status': e.status,
        'Reason': e.reason || '',
        'Created At': new Date(e.createdAt).toLocaleString()
      }));
      fileName = `JobDetails_${job.uploadedFile}.xlsx`;
    }

    const worksheet = xlsx.utils.json_to_sheet(dataToExport);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Data');
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error exporting data' });
  }
});

// @route   POST api/purchases/start-automation
router.post('/start-automation', requireAuth, async (req, res) => {
  try {
    const { jobId, headless } = req.body;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID parameter is required' });

    const job = await AutomationJob.findOne({ _id: jobId, userId: req.user._id });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    if (['pending', 'running'].includes(job.status)) {
      return res.status(400).json({ success: false, message: 'Automation is already running or queued.' });
    }

    const pendingCount = await Purchase.countDocuments({ jobId: job._id, status: 'pending' });
    if (pendingCount === 0) {
      return res.status(400).json({ success: false, message: 'No pending records to process. Use Retry.' });
    }

    job.status = 'pending';
    job.reason = 'Queued for Flipkart automation...';
    await job.save();

    await Purchase.updateMany(
      { jobId: job._id, status: 'pending' },
      { reason: 'Queued for automation...', screenshot: '' }
    );

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'status-change', jobId });

    const { runFlipkartAutomation } = await import('../playwright/automation.js');
    runFlipkartAutomation(job._id.toString(), req.user._id, headless !== false, req.app.locals.io);

    return res.status(200).json({ success: true, message: `Job started. Processing ${pendingCount} record(s).` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error starting automation task' });
  }
});

// @route   POST api/purchases/stop-automation
router.post('/stop-automation', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID parameter is required' });

    const result = await AutomationJob.updateOne(
      { _id: jobId, userId: req.user._id },
      { status: 'stopped', reason: 'Stopped by user request.' }
    );

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'status-change', jobId });

    return res.status(200).json({ success: true, message: `Stopped automation job successfully.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error stopping automation' });
  }
});

// @route   POST api/purchases/retry-automation
router.post('/retry-automation', requireAuth, async (req, res) => {
  try {
    const { jobId, reasonFilter, headless } = req.body;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID parameter is required' });

    const job = await AutomationJob.findOne({ _id: jobId, userId: req.user._id });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    if (['pending', 'running'].includes(job.status)) {
      return res.status(400).json({ success: false, message: 'Automation is already running.' });
    }

    const query = { jobId: job._id, status: 'failed' };
    if (reasonFilter && reasonFilter !== 'all') query.reason = reasonFilter;

    const count = await Purchase.countDocuments(query);
    if (count === 0) return res.status(400).json({ success: false, message: 'No failed records found.' });

    await Purchase.updateMany(query, { status: 'pending', reason: 'Queued for retry...', screenshot: '' });

    job.status = 'pending';
    job.reason = `Retrying automation for ${count} failed record(s)...`;
    await job.save();

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'status-change', jobId });

    const { runFlipkartAutomation } = await import('../playwright/automation.js');
    runFlipkartAutomation(job._id.toString(), req.user._id, headless !== false, req.app.locals.io);

    return res.status(200).json({ success: true, message: `Retrying automation for ${count} record(s).` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error retrying automation' });
  }
});

// @route   POST api/purchases/retry-single
router.post('/retry-single', requireAuth, async (req, res) => {
  try {
    const { recordId, headless } = req.body;
    if (!recordId) return res.status(400).json({ success: false, message: 'Record ID parameter is required' });

    const record = await Purchase.findById(recordId);
    if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

    const job = await AutomationJob.findOne({ _id: record.jobId, userId: req.user._id });
    if (!job) return res.status(403).json({ success: false, message: 'Unauthorized job access' });

    record.status = 'pending';
    record.reason = 'Queued for retry...';
    record.screenshot = '';
    await record.save();

    job.status = 'pending';
    job.reason = `Retrying automation for record ${record.email}...`;
    await job.save();

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'status-change', jobId: job._id });

    const { runFlipkartAutomation } = await import('../playwright/automation.js');
    runFlipkartAutomation(job._id.toString(), req.user._id, headless !== false, req.app.locals.io, recordId);

    return res.status(200).json({ success: true, message: `Retrying automation for record ${record.email}.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error retrying single record' });
  }
});

// @route   PATCH api/purchases/soft-delete/:jobId
router.patch('/soft-delete/:jobId', requireAuth, async (req, res) => {
  try {
    const job = await AutomationJob.findOne({ _id: req.params.jobId, userId: req.user._id });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    if (['pending', 'running'].includes(job.status)) {
      return res.status(400).json({ success: false, message: 'Cannot delete a running job.' });
    }

    job.isDeleted = true;
    job.deletedAt = new Date();
    await job.save();

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'soft-delete', jobId: job._id });

    return res.status(200).json({ success: true, message: `Job "${job.uploadedFile}" moved to trash.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error soft-deleting job' });
  }
});

// @route   DELETE api/purchases/permanent-delete/:jobId
router.delete('/permanent-delete/:jobId', requireAuth, async (req, res) => {
  try {
    const job = await AutomationJob.findOne({ _id: req.params.jobId, userId: req.user._id });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    if (!job.isDeleted) {
      return res.status(400).json({ success: false, message: 'Move to trash first.' });
    }

    await Purchase.deleteMany({ jobId: job._id });
    await AutomationJob.deleteOne({ _id: job._id });

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'permanent-delete', jobId: job._id });

    return res.status(200).json({ success: true, message: `Job permanently deleted.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error permanently deleting job' });
  }
});

// @route   PATCH api/purchases/restore/:jobId
router.patch('/restore/:jobId', requireAuth, async (req, res) => {
  try {
    const result = await AutomationJob.updateOne(
      { _id: req.params.jobId, userId: req.user._id, isDeleted: true },
      { $set: { isDeleted: false }, $unset: { deletedAt: '' } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ success: false, message: 'Trashed job not found' });

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'restore', jobId: req.params.jobId });

    return res.status(200).json({ success: true, message: 'Job restored successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error restoring job' });
  }
});

export default router;
