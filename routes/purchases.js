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

// @route   GET api/purchases/last-job-summary
// @desc    Get the most recent job with its counts and last processed record
router.get('/last-job-summary', requireAuth, async (req, res) => {
  try {
    const lastJob = await AutomationJob.findOne(
      { userId: req.user._id, isDeleted: false, type: 'purchase' }
    ).sort({ createdAt: -1 });

    if (!lastJob) {
      return res.status(200).json({ success: true, data: null });
    }

    // Get counts
    const counts = await Purchase.aggregate([
      { $match: { jobId: lastJob._id } },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        success: { $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } }
      }}
    ]);
    const stats = counts.length > 0 ? counts[0] : { total: 0, success: 0, failed: 0, pending: 0 };

    // Get last processed record (most recently updated non-pending)
    const lastRecord = await Purchase.findOne(
      { jobId: lastJob._id, status: { $in: ['success', 'failed', 'inprogress'] } }
    ).sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      data: {
        jobId: lastJob._id,
        jobName: lastJob.uploadedFile,
        jobStatus: lastJob.status,
        jobReason: lastJob.reason,
        jobCreatedAt: lastJob.createdAt,
        totalRecords: stats.total,
        successCount: stats.success,
        failedCount: stats.failed,
        pendingCount: stats.pending,
        lastRecord: lastRecord ? {
          email: lastRecord.email,
          name: lastRecord.name,
          status: lastRecord.status,
          reason: lastRecord.reason,
          orderId: lastRecord.orderId,
          updatedAt: lastRecord.updatedAt
        } : null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error fetching last job summary' });
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
    const ExcelJS = (await import('exceljs')).default;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = req.user.name || req.user.email || 'System';
    workbook.created = new Date();

    let fileName = 'export.xlsx';

    // ── Helper: style header row ──
    const styleHeader = (sheet) => {
      const headerRow = sheet.getRow(1);
      headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin' }, bottom: { style: 'thin' },
          left: { style: 'thin' }, right: { style: 'thin' }
        };
      });
      headerRow.height = 22;
    };

    // ── Helper: alternating row colors ──
    const applyAlternatingRows = (sheet) => {
      const lightGray = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header
        row.eachCell(cell => {
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
          };
          cell.alignment = { vertical: 'middle', wrapText: true };
          if (rowNumber % 2 === 0) {
            cell.fill = lightGray;
          }
        });
      });
    };

    // ── Helper: auto-fit column widths ──
    const autoFitColumns = (sheet) => {
      sheet.columns.forEach(col => {
        let maxLen = col.header ? col.header.length : 10;
        col.eachCell({ includeEmpty: false }, cell => {
          const len = cell.value ? cell.value.toString().length : 0;
          if (len > maxLen) maxLen = len;
        });
        col.width = Math.min(maxLen + 4, 50);
      });
    };

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
            failedCount: { $size: { $filter: { input: "$records", as: "e", cond: { $eq: ["$$e.status", "failed"] } } } },
            pendingCount: { $size: { $filter: { input: "$records", as: "e", cond: { $eq: ["$$e.status", "pending"] } } } }
        }}
      ]);

      const sheet = workbook.addWorksheet('Jobs');
      const columns = [
        { header: 'S.No', key: 'sno', width: 6 },
        { header: 'Job Name', key: 'jobName', width: 25 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Reason', key: 'reason', width: 30 },
        { header: 'Total Records', key: 'total', width: 14 },
        { header: 'Success', key: 'success', width: 10 },
        { header: 'Failed', key: 'failed', width: 10 },
        { header: 'Pending', key: 'pending', width: 10 },
        { header: 'Created At', key: 'createdAt', width: 22 },
      ];
      if (isDeleted) columns.push({ header: 'Deleted At', key: 'deletedAt', width: 22 });
      sheet.columns = columns;

      jobsList.forEach((j, i) => {
        const row = {
          sno: i + 1,
          jobName: j.uploadedFile,
          status: j.status,
          reason: j.reason || '',
          total: j.totalRecords,
          success: j.successCount,
          failed: j.failedCount,
          pending: j.pendingCount,
          createdAt: new Date(j.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        };
        if (isDeleted) row.deletedAt = j.deletedAt ? new Date(j.deletedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
        sheet.addRow(row);
      });

      styleHeader(sheet);
      applyAlternatingRows(sheet);
      autoFitColumns(sheet);
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

      // ── Info Sheet (metadata) ──
      const infoSheet = workbook.addWorksheet('Export Info');
      infoSheet.columns = [
        { header: 'Field', key: 'field', width: 22 },
        { header: 'Value', key: 'value', width: 45 }
      ];
      const infoRows = [
        { field: 'Exported By', value: req.user.name || req.user.email || 'Unknown' },
        { field: 'Export Date', value: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) },
        { field: 'Job Name', value: job.uploadedFile },
        { field: 'Job Status', value: job.status },
        { field: 'Job Reason', value: job.reason || '' },
        { field: 'Total Records', value: records.length },
        { field: 'Success', value: records.filter(r => r.status === 'success').length },
        { field: 'Failed', value: records.filter(r => r.status === 'failed').length },
        { field: 'Pending', value: records.filter(r => r.status === 'pending').length },
        { field: 'Job Created At', value: new Date(job.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) },
      ];
      infoRows.forEach(r => infoSheet.addRow(r));
      styleHeader(infoSheet);
      applyAlternatingRows(infoSheet);

      // ── Data Sheet (all fields) ──
      const sheet = workbook.addWorksheet('Records');
      sheet.columns = [
        { header: 'S.No', key: 'sno', width: 6 },
        { header: 'Email', key: 'email', width: 28 },
        { header: 'Name', key: 'name', width: 18 },
        { header: 'Product Link', key: 'productlink', width: 40 },
        { header: 'Seller Name', key: 'sellername', width: 18 },
        { header: 'Phone', key: 'phone', width: 14 },
        { header: 'Pincode', key: 'pincode', width: 10 },
        { header: 'Address Line 1', key: 'addressline1', width: 30 },
        { header: 'Address Line 2', key: 'addressline2', width: 22 },
        { header: 'Landmark', key: 'landmark', width: 18 },
        { header: 'Alternate Phone', key: 'alternatephone', width: 16 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Order ID', key: 'orderId', width: 22 },
        { header: 'Reason', key: 'reason', width: 35 },
        { header: 'Address Saved', key: 'addressSaved', width: 14 },
        { header: 'Created At', key: 'createdAt', width: 22 },
        { header: 'Completed At', key: 'completedAt', width: 22 },
      ];

      records.forEach((e, i) => {
        sheet.addRow({
          sno: i + 1,
          email: e.email,
          name: e.name || '',
          productlink: e.productlink || '',
          sellername: e.sellername || '',
          phone: e.phone || '',
          pincode: e.pincode || '',
          addressline1: e.addressline1 || '',
          addressline2: e.addressline2 || '',
          landmark: e.landmark || '',
          alternatephone: e.alternatephone || '',
          status: e.status,
          orderId: e.orderId || '',
          reason: e.reason || '',
          addressSaved: e.addressSaved ? 'Yes' : 'No',
          createdAt: new Date(e.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
          completedAt: e.completedAt ? new Date(e.completedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
        });
      });

      styleHeader(sheet);
      applyAlternatingRows(sheet);
      autoFitColumns(sheet);
      fileName = `JobDetails_${job.uploadedFile}.xlsx`;
    }

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('[Export Error]', err);
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

    const failedRecords = await Purchase.find(query).select('_id');
    const count = failedRecords.length;
    if (count === 0) return res.status(400).json({ success: false, message: 'No failed records found.' });

    const failedRecordIds = failedRecords.map(r => r._id.toString());

    await Purchase.updateMany(query, { status: 'pending', reason: 'Queued for retry...', screenshot: '' });

    job.status = 'pending';
    job.reason = `Retrying automation for ${count} failed record(s)...`;
    await job.save();

    if (req.app.locals.io) req.app.locals.io.emit('job-update', { type: 'status-change', jobId });

    const { runFlipkartAutomation } = await import('../playwright/automation.js');
    runFlipkartAutomation(job._id.toString(), req.user._id, headless !== false, req.app.locals.io, failedRecordIds);

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
