import express from 'express';
import multer from 'multer';
import * as xlsx from 'xlsx';
import { requireAuth } from '../middleware/auth.js';
import AutomationJob from '../models/AutomationJob.js';
import CancelOrder from '../models/CancelOrder.js';

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

// @route   POST /api/cancel/upload
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Please upload an Excel file' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = xlsx.utils.sheet_to_json(worksheet);

    if (jsonData.length === 0) return res.status(400).json({ success: false, message: 'The Excel sheet is empty' });

    const parsedRecords = [];
    for (const row of jsonData) {
      const email = getFieldValue(row, ['email', 'emailid', 'mail', 'emailaddress']);
      const orderId = getFieldValue(row, ['orderid', 'order', 'ordernum', 'ordernumber']);
      if (email && orderId) {
        parsedRecords.push({
          email: email.toLowerCase(),
          orderId,
          reasonvalue: getFieldValue(row, ['reasonvalue', 'reason', 'cancelreason', 'reasoncode']),
          reasontext: getFieldValue(row, ['reasontext', 'reasondesc', 'description', 'canceltext']),
          seller: getFieldValue(row, ['seller', 'sellername', 'vendor']),
        });
      }
    }

    if (parsedRecords.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid records with email and orderId could be detected.' });
    }

    const job = new AutomationJob({
      userId: req.user._id,
      uploadedFile: req.file.originalname,
      type: 'cancel',
      status: 'idle',
      reason: 'Ready to start...'
    });
    await job.save();

    const dbRecords = parsedRecords.map(record => ({ jobId: job._id, ...record, status: 'pending' }));
    const savedRecords = await CancelOrder.insertMany(dbRecords);

    if (req.app.locals.io) req.app.locals.io.emit('cancel-job-update', { type: 'new-job', jobId: job._id });

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

// @route   GET /api/cancel/stats
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const jobsCount = await AutomationJob.countDocuments({ isDeleted: false, type: 'cancel' });
    const activeJobs = await AutomationJob.find({ isDeleted: false, type: 'cancel' }, '_id status');

    let runningCount = 0;
    const jobIds = activeJobs.map(j => {
      if (j.status === 'running' || j.status === 'pending') runningCount++;
      return j._id;
    });

    const recordStats = await CancelOrder.aggregate([
      { $match: { jobId: { $in: jobIds } } },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
      }}
    ]);

    const stats = recordStats.length > 0 ? recordStats[0] : { total: 0, success: 0, failed: 0 };

    return res.status(200).json({
      success: true,
      stats: { jobs: jobsCount, runningJobs: runningCount, total: stats.total, success: stats.success, failed: stats.failed }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching stats' });
  }
});

// @route   GET /api/cancel/files
router.get('/files', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    const matchQuery = { isDeleted: false, type: 'cancel' };
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
      { $lookup: { from: 'cancelorders', localField: '_id', foreignField: 'jobId', as: 'records' } },
      { $project: {
          _id: 1, uploadedFile: 1, status: 1, reason: 1, createdAt: 1,
          totalRecords: { $size: '$records' },
          successCount: { $size: { $filter: { input: '$records', as: 'e', cond: { $eq: ['$$e.status', 'success'] } } } },
          failedCount: { $size: { $filter: { input: '$records', as: 'e', cond: { $eq: ['$$e.status', 'failed'] } } } },
          pendingCount: { $size: { $filter: { input: '$records', as: 'e', cond: { $eq: ['$$e.status', 'pending'] } } } },
      }}
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
      success: true, data: formattedJobs, totalRecords,
      totalPages: Math.ceil(totalRecords / limit), currentPage: page
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching cancel jobs list' });
  }
});

// @route   POST /api/cancel/start-automation
router.post('/start-automation', requireAuth, async (req, res) => {
  try {
    const { jobId, headless } = req.body;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID is required' });

    const job = await AutomationJob.findOne({ _id: jobId });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    if (['pending', 'running'].includes(job.status)) {
      return res.status(400).json({ success: false, message: 'Automation is already running or queued. Stop it first from any system.' });
    }

    const pendingCount = await CancelOrder.countDocuments({ jobId: job._id, status: 'pending' });
    if (pendingCount === 0) {
      return res.status(400).json({ success: false, message: 'No pending records to process.' });
    }

    // Atomic update — prevents race condition from multiple systems
    const updated = await AutomationJob.findOneAndUpdate(
      { _id: jobId, status: { $nin: ['pending', 'running'] } },
      { status: 'pending', reason: 'Queued for cancel automation...' },
      { new: true }
    );
    if (!updated) {
      return res.status(400).json({ success: false, message: 'Job was already started by another system.' });
    }

    if (req.app.locals.io) req.app.locals.io.emit('cancel-job-update', { type: 'status-change', jobId });

    const { runCancelAutomation } = await import('../playwright/cancelAutomation.js');
    runCancelAutomation(job._id.toString(), req.user._id, headless !== false, req.app.locals.io);

    return res.status(200).json({ success: true, message: `Job started. Processing ${pendingCount} record(s).` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error starting cancel automation' });
  }
});

// @route   POST /api/cancel/stop-automation
router.post('/stop-automation', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID is required' });

    // Any system can stop — just update DB, automation loop will detect it
    const result = await AutomationJob.findOneAndUpdate(
      { _id: jobId, status: { $in: ['pending', 'running'] } },
      { status: 'stopped', reason: 'Stopped by user request.' },
      { new: true }
    );

    if (!result) {
      return res.status(400).json({ success: false, message: 'Job is not running or already stopped.' });
    }

    if (req.app.locals.io) req.app.locals.io.emit('cancel-job-update', { type: 'status-change', jobId });

    return res.status(200).json({ success: true, message: 'Stop signal sent. Automation will halt after current record.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error stopping automation' });
  }
});

// @route   PATCH /api/cancel/soft-delete/:jobId
router.patch('/soft-delete/:jobId', requireAuth, async (req, res) => {
  try {
    const job = await AutomationJob.findOne({ _id: req.params.jobId });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    if (['pending', 'running'].includes(job.status)) {
      return res.status(400).json({ success: false, message: 'Cannot delete a running job.' });
    }

    job.isDeleted = true;
    job.deletedAt = new Date();
    await job.save();

    if (req.app.locals.io) req.app.locals.io.emit('cancel-job-update', { type: 'soft-delete', jobId: job._id });

    return res.status(200).json({ success: true, message: `Job "${job.uploadedFile}" moved to trash.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error deleting job' });
  }
});

// @route   GET /api/cancel/file-details
router.get('/file-details', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID is required' });

    const job = await AutomationJob.findOne({ _id: jobId, isDeleted: false });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || 'createdAt';
    const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

    const matchQuery = { jobId: job._id };
    if (req.query.search) {
      matchQuery.$or = [
        { email: { $regex: req.query.search, $options: 'i' } },
        { orderId: { $regex: req.query.search, $options: 'i' } },
        { status: { $regex: req.query.search, $options: 'i' } },
        { reason: { $regex: req.query.search, $options: 'i' } },
      ];
    }

    const sortParams = { [sortField]: sortOrder, _id: 1 };
    const totalRecordsCount = await CancelOrder.countDocuments(matchQuery);
    const records = await CancelOrder.find(matchQuery).sort(sortParams).skip(skip).limit(limit);

    const allRecords = await CancelOrder.find({ jobId: job._id }, 'status');
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
    return res.status(500).json({ success: false, message: 'Error fetching cancel job details' });
  }
});

// @route   GET /api/cancel/export
router.get('/export', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID is required' });

    const job = await AutomationJob.findOne({ _id: jobId });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    const records = await CancelOrder.find({ jobId: job._id }).sort({ createdAt: 1 });

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PurchaseFlow';
    workbook.created = new Date();

    // Info sheet
    const infoSheet = workbook.addWorksheet('Export Info');
    infoSheet.columns = [
      { header: 'Field', key: 'field', width: 22 },
      { header: 'Value', key: 'value', width: 45 }
    ];
    [
      { field: 'Job Name', value: job.uploadedFile },
      { field: 'Job Status', value: job.status },
      { field: 'Export Date', value: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) },
      { field: 'Total Records', value: records.length },
      { field: 'Success', value: records.filter(r => r.status === 'success').length },
      { field: 'Failed', value: records.filter(r => r.status === 'failed').length },
      { field: 'Pending', value: records.filter(r => r.status === 'pending').length },
    ].forEach(r => infoSheet.addRow(r));

    const styleHeader = (sheet) => {
      sheet.getRow(1).eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      });
      sheet.getRow(1).height = 22;
    };

    const applyRows = (sheet) => {
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.eachCell(cell => {
          cell.border = { top: { style: 'thin', color: { argb: 'FFE0E0E0' } }, bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } }, left: { style: 'thin', color: { argb: 'FFE0E0E0' } }, right: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
          cell.alignment = { vertical: 'middle', wrapText: true };
          if (rowNumber % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
        });
      });
    };

    styleHeader(infoSheet);
    applyRows(infoSheet);

    // Data sheet
    const sheet = workbook.addWorksheet('Cancel Records');
    sheet.columns = [
      { header: 'S.No', key: 'sno', width: 6 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Order ID', key: 'orderId', width: 24 },
      { header: 'Reason Value', key: 'reasonvalue', width: 20 },
      { header: 'Reason Text', key: 'reasontext', width: 30 },
      { header: 'Seller', key: 'seller', width: 18 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Log / Reason', key: 'reason', width: 40 },
      { header: 'Created At', key: 'createdAt', width: 22 },
      { header: 'Completed At', key: 'completedAt', width: 22 },
    ];

    records.forEach((r, i) => {
      sheet.addRow({
        sno: i + 1,
        email: r.email,
        orderId: r.orderId || '',
        reasonvalue: r.reasonvalue || '',
        reasontext: r.reasontext || '',
        seller: r.seller || '',
        status: r.status,
        reason: r.reason || '',
        createdAt: new Date(r.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        completedAt: r.completedAt ? new Date(r.completedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
      });
    });

    styleHeader(sheet);
    applyRows(sheet);
    sheet.columns.forEach(col => {
      let maxLen = col.header ? col.header.length : 10;
      col.eachCell({ includeEmpty: false }, cell => {
        const len = cell.value ? cell.value.toString().length : 0;
        if (len > maxLen) maxLen = len;
      });
      col.width = Math.min(maxLen + 4, 50);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `CancelOrders_${job.uploadedFile}_${Date.now()}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('[Cancel Export Error]', err);
    return res.status(500).json({ success: false, message: 'Error exporting data' });
  }
});

// @route   GET /api/cancel/trash
router.get('/trash', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const sortField = req.query.sortField || 'deletedAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const matchQuery = { isDeleted: true, type: 'cancel' };
    if (req.query.search) {
      matchQuery.$or = [
        { uploadedFile: { $regex: req.query.search, $options: 'i' } },
        { status: { $regex: req.query.search, $options: 'i' } }
      ];
    }
    if (req.query.startDate || req.query.endDate) {
      matchQuery.deletedAt = {};
      if (req.query.startDate) matchQuery.deletedAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) matchQuery.deletedAt.$lte = new Date(req.query.endDate);
    }
    const totalRecords = await AutomationJob.countDocuments(matchQuery);
    const trashedJobs = await AutomationJob.aggregate([
      { $match: matchQuery },
      { $sort: { [sortField]: sortOrder } },
      { $skip: skip }, { $limit: limit },
      { $lookup: { from: 'cancelorders', localField: '_id', foreignField: 'jobId', as: 'records' } },
      { $project: {
          _id: 1, uploadedFile: 1, status: 1, createdAt: 1, deletedAt: 1,
          totalRecords: { $size: '$records' },
          successCount: { $size: { $filter: { input: '$records', as: 'e', cond: { $eq: ['$$e.status', 'success'] } } } }
      }}
    ]);
    return res.status(200).json({ success: true, data: trashedJobs, totalRecords, totalPages: Math.ceil(totalRecords / limit), currentPage: page });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching cancel trash' });
  }
});

// @route   PATCH /api/cancel/restore/:jobId
router.patch('/restore/:jobId', requireAuth, async (req, res) => {
  try {
    const result = await AutomationJob.updateOne(
      { _id: req.params.jobId, isDeleted: true },
      { $set: { isDeleted: false }, $unset: { deletedAt: '' } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ success: false, message: 'Trashed job not found' });
    if (req.app.locals.io) req.app.locals.io.emit('cancel-job-update', { type: 'restore', jobId: req.params.jobId });
    return res.status(200).json({ success: true, message: 'Job restored successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error restoring job' });
  }
});

// @route   DELETE /api/cancel/permanent-delete/:jobId
router.delete('/permanent-delete/:jobId', requireAuth, async (req, res) => {
  try {
    const job = await AutomationJob.findOne({ _id: req.params.jobId });
    if (!job || !job.isDeleted) return res.status(404).json({ success: false, message: 'Job not found in trash' });
    await CancelOrder.deleteMany({ jobId: job._id });
    await AutomationJob.deleteOne({ _id: job._id });
    if (req.app.locals.io) req.app.locals.io.emit('cancel-job-update', { type: 'permanent-delete', jobId: job._id });
    return res.status(200).json({ success: true, message: 'Job permanently deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error permanently deleting job' });
  }
});

// @route   POST /api/cancel/retry-automation
router.post('/retry-automation', requireAuth, async (req, res) => {
  try {
    const { jobId, reasonFilters, headless } = req.body;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID is required' });

    const job = await AutomationJob.findOne({ _id: jobId });
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    if (['pending', 'running'].includes(job.status)) {
      return res.status(400).json({ success: false, message: 'Automation is already running.' });
    }

    // Build query — if reasonFilters array provided, filter by those reasons
    const query = { jobId: job._id, status: 'failed' };
    if (reasonFilters && reasonFilters.length > 0 && !reasonFilters.includes('all')) {
      query.reason = { $in: reasonFilters };
    }

    const failedRecords = await CancelOrder.find(query);
    if (failedRecords.length === 0) {
      return res.status(400).json({ success: false, message: 'No failed records found for selected filters.' });
    }

    await CancelOrder.updateMany(query, { status: 'pending', reason: 'Queued for retry...', screenshot: '' });

    job.status = 'pending';
    job.reason = `Retrying ${failedRecords.length} failed record(s)...`;
    await job.save();

    if (req.app.locals.io) req.app.locals.io.emit('cancel-job-update', { type: 'status-change', jobId });

    const { runCancelAutomation } = await import('../playwright/cancelAutomation.js');
    runCancelAutomation(job._id.toString(), req.user._id, headless !== false, req.app.locals.io);

    return res.status(200).json({ success: true, message: `Retrying ${failedRecords.length} record(s).` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error retrying automation' });
  }
});

// @route   GET /api/cancel/failed-reasons
router.get('/failed-reasons', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.query;
    if (!jobId) return res.status(400).json({ success: false, message: 'Job ID is required' });

    const reasons = await CancelOrder.distinct('reason', { jobId, status: 'failed', reason: { $nin: [null, ''] } });
    const reasonsWithCount = await Promise.all(
      reasons.map(async (reason) => ({
        reason,
        count: await CancelOrder.countDocuments({ jobId, status: 'failed', reason })
      }))
    );

    return res.status(200).json({ success: true, data: reasonsWithCount });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching failed reasons' });
  }
});

// @route   GET /api/cancel/sample-csv
router.get('/sample-csv', requireAuth, (req, res) => {
  const csv = '"Email","Order ID","Reason Value","Reason Text"\n"user@example.com","OD123456789","Item not required","Changed my mind about the purchase"';
  res.setHeader('Content-Disposition', 'attachment; filename="sample_cancel_template.csv"');
  res.setHeader('Content-Type', 'text/csv');
  return res.status(200).send(csv);
});

export default router;
