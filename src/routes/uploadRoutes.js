const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { 
  upload, 
  uploadBill, 
  getDocuments, 
  getDocument,
  deleteDocument 
} = require('../controllers/uploadController');
const { authorize } = require('../middleware/auth');

router.use(authorize('uploader', 'manager', 'admin'));

// Upload bill
router.post('/upload', upload.single('bill'), uploadBill);

// Get all documents
router.get('/documents', getDocuments);

// Get single document
router.get('/documents/:id', getDocument);

// Delete document
router.delete('/documents/:id', deleteDocument);

// View/Download file
router.get('/files/:id', async (req, res) => {
  try {
    const pool = require('../config/database');
    const { id } = req.params;
    
    // Get document info from database
    const result = await pool.query(
      'SELECT * FROM documents WHERE document_id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const doc = result.rows[0];
    const filePath = doc.file_path;
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }
    
    // Set appropriate headers
    res.setHeader('Content-Type', doc.file_type);
    res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
    
    // Send file
    res.sendFile(path.resolve(filePath));
    
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).json({ error: 'Error serving file' });
  }
});

// Download file (force download instead of preview)
router.get('/files/:id/download', async (req, res) => {
  try {
    const pool = require('../config/database');
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM documents WHERE document_id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const doc = result.rows[0];
    const filePath = doc.file_path;
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }
    
    // Force download
    res.setHeader('Content-Type', doc.file_type);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
    
    res.sendFile(path.resolve(filePath));
    
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ error: 'Error downloading file' });
  }
});

module.exports = router;
