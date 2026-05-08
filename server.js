const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const config = normalizeConfig(loadConfig());
const serverHost = config.server.host || '0.0.0.0';
const serverPort = toPositiveInt(config.server.port, 8080);
const uploadMaxBytes = toPositiveInt(config.upload.maxFileSizeMB, 100) * 1024 * 1024;
let discoveredBucketsCache = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  try {
    const base = `http://${req.headers.host || '127.0.0.1'}`;
    const requestUrl = new URL(req.url || '/', base);

    if (requestUrl.pathname.startsWith('/api/')) {
      await handleApi(req, res, requestUrl);
      return;
    }

    await serveStatic(req, res, requestUrl);
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      message: error.message || '服务器异常'
    });
  }
});

server.listen(serverPort, serverHost, () => {
  console.log(`OSS 上传网页已启动: http://127.0.0.1:${serverPort}`);
});

async function handleApi(req, res, requestUrl) {
  if (requestUrl.pathname === '/api/health' && req.method === 'GET') {
    const buckets = await getBuckets();
    sendJson(res, 200, {
      success: true,
      message: 'ok',
      bucketCount: buckets.length,
      buckets: buckets.map(item => ({
        id: item.id,
        name: item.name,
        region: item.region,
        endpoint: item.endpoint
      }))
    });
    return;
  }

  if (requestUrl.pathname === '/api/oss/files' && req.method === 'GET') {
    return handleListFiles(res, requestUrl);
  }

  if (requestUrl.pathname === '/api/oss/file' && req.method === 'GET') {
    return handleGetFile(res, requestUrl);
  }

  if (requestUrl.pathname === '/api/oss/file' && req.method === 'PUT') {
    return handleSaveFile(req, res);
  }

  if (requestUrl.pathname === '/api/oss/file' && req.method === 'DELETE') {
    return handleDeleteFile(res, requestUrl);
  }

  if (requestUrl.pathname === '/api/oss/upload' && req.method === 'POST') {
    return handleUpload(req, res);
  }

  sendJson(res, 404, {
    success: false,
    message: '接口不存在'
  });
}

async function handleListFiles(res, requestUrl) {
  try {
    validateOssConfig();
    const maxKeys = clamp(toPositiveInt(requestUrl.searchParams.get('maxKeys'), getDefaultListMaxKeys()), 1, 1000);
    const buckets = await getBuckets();
    const results = await Promise.all(buckets.map(async bucket => ({
      bucket,
      result: await ossListFiles(bucket, maxKeys)
    })));

    const merged = mergeFiles(results, maxKeys);
    sendJson(res, 200, {
      success: true,
      bucketCount: buckets.length,
      count: merged.files.length,
      isTruncated: merged.isTruncated,
      files: merged.files
    });
  } catch (error) {
    sendJson(res, resolveStatusCode(error), {
      success: false,
      message: error.message || '读取文件列表失败'
    });
  }
}

async function handleGetFile(res, requestUrl) {
  try {
    validateOssConfig();
    const key = normalizeObjectKey(requestUrl.searchParams.get('key'));
    if (!key) {
      return sendJson(res, 400, { success: false, message: '缺少文件 key' });
    }

    if (!isEditableFile(key)) {
      return sendJson(res, 400, { success: false, message: '该文件类型暂不支持在线编辑' });
    }

    const buckets = await getBuckets();
    const result = await ossGetFirstAvailableObject(buckets, key);
    sendJson(res, 200, {
      success: true,
      key,
      content: result.body.toString('utf8'),
      contentType: guessMimeType(key),
      sourceBucket: result.bucket.name
    });
  } catch (error) {
    sendJson(res, resolveStatusCode(error), {
      success: false,
      message: error.message || '读取文件内容失败'
    });
  }
}

async function handleSaveFile(req, res) {
  try {
    validateOssConfig();
    const body = await readJsonBody(req, 10 * 1024 * 1024);
    const key = normalizeObjectKey(body && body.key);
    const content = body && typeof body.content === 'string' ? body.content : null;

    if (!key) {
      return sendJson(res, 400, { success: false, message: '缺少文件 key' });
    }

    if (!isEditableFile(key)) {
      return sendJson(res, 400, { success: false, message: '该文件类型暂不支持在线编辑' });
    }

    if (content === null) {
      return sendJson(res, 400, { success: false, message: '缺少要保存的内容' });
    }

    const buckets = await getBuckets();
    const mimeType = guessMimeType(key);
    const results = await Promise.all(
      buckets.map(bucket => ossPutObject(bucket, key, Buffer.from(content, 'utf8'), mimeType))
    );

    sendJson(res, 200, {
      success: true,
      key,
      syncedBuckets: buckets.length,
      statusCodes: results,
      urls: buckets.map(bucket => buildFileUrl(bucket, key))
    });
  } catch (error) {
    sendJson(res, resolveStatusCode(error), {
      success: false,
      message: error.message || '保存文件失败'
    });
  }
}

async function handleDeleteFile(res, requestUrl) {
  try {
    validateOssConfig();
    const key = normalizeObjectKey(requestUrl.searchParams.get('key'));
    if (!key) {
      return sendJson(res, 400, { success: false, message: '缺少文件 key' });
    }

    const buckets = await getBuckets();
    const results = await Promise.all(
      buckets.map(bucket => ossDeleteObject(bucket, key))
    );

    sendJson(res, 200, {
      success: true,
      key,
      syncedBuckets: buckets.length,
      statusCodes: results
    });
  } catch (error) {
    sendJson(res, resolveStatusCode(error), {
      success: false,
      message: error.message || '删除文件失败'
    });
  }
}

async function handleUpload(req, res) {
  try {
    validateOssConfig();
    const originalFilename = decodeHeaderFilename(String(req.headers['x-file-name'] || ''));
    if (!originalFilename) {
      return sendJson(res, 400, { success: false, message: '缺少上传文件名' });
    }

    const fileBuffer = await readRequestBuffer(req, uploadMaxBytes);
    if (!fileBuffer.length) {
      return sendJson(res, 400, { success: false, message: '上传内容为空' });
    }

    const buckets = await getBuckets();
    const objectKey = buildRootObjectKey(originalFilename);
    const mimeType = String(req.headers['content-type'] || '').trim() || guessMimeType(originalFilename);
    const results = await Promise.all(
      buckets.map(bucket => ossPutObject(bucket, objectKey, fileBuffer, mimeType))
    );

    sendJson(res, 200, {
      success: true,
      originalFilename,
      objectKey,
      syncedBuckets: buckets.length,
      statusCodes: results,
      urls: buckets.map(bucket => buildFileUrl(bucket, objectKey))
    });
  } catch (error) {
    sendJson(res, resolveStatusCode(error), {
      success: false,
      message: error.message || '上传失败'
    });
  }
}

async function serveStatic(req, res, requestUrl) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
  }

  const requestPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const safePath = safeJoin(PUBLIC_DIR, requestPath);
  if (!safePath) {
    return sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  }

  try {
    const stat = await fsp.stat(safePath);
    if (!stat.isFile()) {
      return sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    }

    const contentType = MIME_TYPES[path.extname(safePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(safePath).pipe(res);
  } catch {
    sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  }
}

function safeJoin(baseDir, relativePath) {
  const normalized = path.normalize(relativePath).replace(/^([/\\])+/, '');
  const targetPath = path.resolve(baseDir, normalized);
  const relative = path.relative(baseDir, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return targetPath;
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': body.length
  });
  res.end(body);
}

function readRequestBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`文件过大，不能超过 ${toPositiveInt(config.upload.maxFileSizeMB, 100)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, maxBytes) {
  const buffer = await readRequestBuffer(req, maxBytes);
  if (!buffer.length) {
    return {};
  }

  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('JSON 格式错误');
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`未找到配置文件: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function normalizeConfig(rawConfig) {
  const raw = rawConfig || {};
  const rawOss = raw.oss || {};
  const fallbackRegion = String(rawOss.region || '').trim();
  const fallbackEndpoint = normalizeEndpoint(rawOss.endpoint || '');

  let buckets = [];
  if (Array.isArray(rawOss.buckets)) {
    buckets = rawOss.buckets;
  } else if (rawOss.bucket) {
    buckets = [{
      id: String(rawOss.bucket),
      name: String(rawOss.bucket),
      region: fallbackRegion,
      endpoint: fallbackEndpoint
    }];
  }

  return {
    server: raw.server || {},
    upload: raw.upload || {},
    list: raw.list || {},
    oss: {
      accessKeyId: String(rawOss.accessKeyId || '').trim(),
      accessKeySecret: String(rawOss.accessKeySecret || '').trim(),
      secure: rawOss.secure !== false,
      discoveryEndpoint: normalizeEndpoint(rawOss.discoveryEndpoint || rawOss.serviceEndpoint || 'oss.aliyuncs.com'),
      buckets: buckets
        .map((item, index) => normalizeBucket(item, index, fallbackRegion, fallbackEndpoint))
        .filter(item => item.name && item.endpoint)
    }
  };
}

function normalizeBucket(item, index, fallbackRegion, fallbackEndpoint) {
  if (typeof item === 'string') {
    const name = item.trim();
    return {
      id: name || `bucket-${index + 1}`,
      name,
      region: fallbackRegion,
      endpoint: fallbackEndpoint
    };
  }

  const bucket = item || {};
  const name = String(bucket.name || bucket.bucket || '').trim();
  const region = String(bucket.region || fallbackRegion || '').trim();
  const endpoint = normalizeEndpoint(bucket.endpoint || fallbackEndpoint || '');
  return {
    id: String(bucket.id || name || `bucket-${index + 1}`).trim(),
    name,
    region,
    endpoint
  };
}

function validateOssConfig() {
  if (!config.oss.accessKeyId) {
    throw new Error('请先在 config.json 中填写有效的 oss.accessKeyId');
  }
  if (!config.oss.accessKeySecret) {
    throw new Error('请先在 config.json 中填写有效的 oss.accessKeySecret');
  }
}

async function getBuckets(forceRefresh = false) {
  validateOssConfig();

  if (Array.isArray(config.oss.buckets) && config.oss.buckets.length > 0) {
    return ensureBucketsAcceleration(config.oss.buckets);
  }

  if (!forceRefresh && Array.isArray(discoveredBucketsCache) && discoveredBucketsCache.length > 0) {
    return ensureBucketsAcceleration(discoveredBucketsCache);
  }

  const buckets = await ossListBuckets();
  if (!buckets.length) {
    throw new Error('未自动获取到任何 Bucket');
  }

  discoveredBucketsCache = buckets;
  return ensureBucketsAcceleration(discoveredBucketsCache);
}

function buildRootObjectKey(originalFilename) {
  const safeName = sanitizeFilename(originalFilename);
  return `${Date.now()}-${randomString(8)}-${safeName}`;
}

function sanitizeFilename(filename) {
  const name = path.basename(filename || 'file.bin');
  return name.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, '_');
}

function randomString(length) {
  return Math.random().toString(36).slice(2, 2 + length);
}

function normalizeObjectKey(value) {
  const key = String(value || '');
  if (!key || key.length > 1024) {
    return '';
  }
  return key;
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function buildFileUrl(bucketConfig, objectKey) {
  const protocol = config.oss.secure === false ? 'http' : 'https';
  const endpoint = bucketConfig.accelerateEnabled
    ? getAccelerateEndpoint(bucketConfig)
    : bucketConfig.endpoint;
  return `${protocol}://${bucketConfig.name}.${endpoint}/${encodeObjectKey(objectKey)}`;
}

function getDefaultListMaxKeys() {
  return toPositiveInt(config.list.maxKeys, 200);
}

function toPositiveInt(value, defaultValue) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : defaultValue;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isEditableFile(key) {
  const ext = path.extname(String(key || '')).toLowerCase();
  return ['.txt', '.json', '.js', '.ts', '.html', '.css', '.md', '.xml', '.yml', '.yaml', '.csv', '.svg'].includes(ext);
}

function guessMimeType(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  const mimeMap = {
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.ts': 'application/typescript; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.yml': 'application/x-yaml; charset=utf-8',
    '.yaml': 'application/x-yaml; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

async function resolveBucket(bucketId) {
  const buckets = await getBuckets();
  const target = String(bucketId || '').trim();
  if (!target) {
    return buckets[0];
  }

  const found = buckets.find(item => item.id === target || item.name === target);
  if (!found) {
    throw new Error(`未找到 bucket: ${target}`);
  }
  return found;
}

async function ossListBuckets() {
  const response = await ossServiceRequest({
    method: 'GET',
    query: {
      'max-keys': '1000'
    }
  });

  const xml = response.body.toString('utf8');
  const blocks = [...xml.matchAll(/<Bucket>([\s\S]*?)<\/Bucket>/g)].map(match => match[1]);
  return blocks
    .map((block, index) => {
      const name = xmlDecode(extractXmlTag(block, 'Name'));
      const location = xmlDecode(extractXmlTag(block, 'Location'));
      const endpoint = normalizeEndpoint(
        xmlDecode(extractXmlTag(block, 'ExtranetEndpoint')) || (location ? `${location}.aliyuncs.com` : '')
      );
      const region = location || xmlDecode(extractXmlTag(block, 'Region'));
      return {
        id: name || `bucket-${index + 1}`,
        name,
        region,
        endpoint
      };
    })
    .filter(item => item.name && item.endpoint);
}

async function ensureBucketsAcceleration(buckets) {
  const needHydrate = buckets.some(item => typeof item.accelerateEnabled !== 'boolean');
  if (!needHydrate) {
    return buckets;
  }

  await Promise.all(buckets.map(async bucket => {
    if (typeof bucket.accelerateEnabled === 'boolean') {
      return;
    }

    try {
      bucket.accelerateEnabled = await ossGetBucketTransferAcceleration(bucket);
    } catch {
      bucket.accelerateEnabled = false;
    }
  }));

  return buckets;
}

function getAccelerateEndpoint(bucketConfig) {
  if (bucketConfig.region && !bucketConfig.region.startsWith('oss-cn-')) {
    return 'oss-accelerate-overseas.aliyuncs.com';
  }
  return 'oss-accelerate.aliyuncs.com';
}

async function ossListFiles(bucketConfig, maxKeys) {
  const response = await ossRequest(bucketConfig, {
    method: 'GET',
    key: '',
    query: {
      'max-keys': String(maxKeys)
    }
  });

  const xml = response.body.toString('utf8');
  const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(match => match[1]);
  const files = contents.map(block => {
    const name = xmlDecode(extractXmlTag(block, 'Key'));
    return {
      name,
      url: buildFileUrl(bucketConfig, name),
      size: Number(extractXmlTag(block, 'Size') || 0),
      lastModified: extractXmlTag(block, 'LastModified'),
      etag: extractXmlTag(block, 'ETag'),
      type: extractXmlTag(block, 'Type'),
      storageClass: extractXmlTag(block, 'StorageClass'),
      editable: isEditableFile(name)
    };
  });

  return {
    files,
    isTruncated: extractXmlTag(xml, 'IsTruncated') === 'true'
  };
}

function mergeFiles(bucketResults, maxKeys) {
  const mergedMap = new Map();
  let hasTruncated = false;

  for (const { bucket, result } of bucketResults) {
    if (result.isTruncated) {
      hasTruncated = true;
    }

    for (const file of result.files) {
      const existing = mergedMap.get(file.name);
      if (!existing) {
        mergedMap.set(file.name, {
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          etag: file.etag,
          type: file.type,
          storageClass: file.storageClass,
          editable: file.editable,
          urls: [file.url],
          buckets: [bucket.name]
        });
        continue;
      }

      existing.urls.push(file.url);
      existing.buckets.push(bucket.name);
      if (new Date(file.lastModified).getTime() > new Date(existing.lastModified).getTime()) {
        existing.lastModified = file.lastModified;
        existing.size = file.size;
        existing.etag = file.etag;
        existing.type = file.type;
        existing.storageClass = file.storageClass;
      }
      existing.editable = existing.editable || file.editable;
    }
  }

  const files = [...mergedMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .map(item => ({
      ...item,
      replicaCount: item.urls.length
    }));

  const sliced = files.slice(0, maxKeys);
  return {
    files: sliced,
    isTruncated: hasTruncated || files.length > maxKeys
  };
}

async function ossGetFirstAvailableObject(buckets, key) {
  let lastError = null;

  for (const bucket of buckets) {
    try {
      const result = await ossGetObject(bucket, key);
      return { bucket, ...result };
    } catch (error) {
      if (error.status === 404 || error.code === 'NoSuchKey') {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('未找到文件');
}

function ossGetObject(bucketConfig, key) {
  return ossRequest(bucketConfig, {
    method: 'GET',
    key
  });
}

async function ossPutObject(bucketConfig, key, body, contentType) {
  const response = await ossRequest(bucketConfig, {
    method: 'PUT',
    key,
    body,
    contentType
  });
  return response.statusCode;
}

async function ossDeleteObject(bucketConfig, key) {
  const response = await ossRequest(bucketConfig, {
    method: 'DELETE',
    key
  });
  return response.statusCode;
}

async function ossGetBucketTransferAcceleration(bucketConfig) {
  const protocol = config.oss.secure === false ? 'http:' : 'https:';
  const requestUrl = `${protocol}//${bucketConfig.name}.${bucketConfig.endpoint}/?transferAcceleration`;
  const date = new Date().toUTCString();
  const authorization = buildBucketSubresourceAuthorization(
    bucketConfig,
    'GET',
    '',
    date,
    '',
    'transferAcceleration'
  );

  const response = await fetch(requestUrl, {
    method: 'GET',
    headers: {
      Date: date,
      Authorization: authorization
    }
  });

  const bodyBuffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw createOssError(response.status, bodyBuffer);
  }

  const xml = bodyBuffer.toString('utf8');
  return extractXmlTag(xml, 'Enabled') === 'true';
}

async function ossRequest(bucketConfig, { method, key, query, body, contentType }) {
  const protocol = config.oss.secure === false ? 'http:' : 'https:';
  const queryString = buildQueryString(query);
  const pathName = key ? `/${encodeObjectKey(key)}` : '/';
  const requestUrl = `${protocol}//${bucketConfig.name}.${bucketConfig.endpoint}${pathName}${queryString}`;
  const date = new Date().toUTCString();
  const authorization = buildBucketAuthorization(bucketConfig, method, key || '', date, contentType || '');

  const headers = {
    Date: date,
    Authorization: authorization
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  const response = await fetch(requestUrl, {
    method,
    headers,
    body: body || undefined
  });

  const bodyBuffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw createOssError(response.status, bodyBuffer);
  }

  return {
    statusCode: response.status,
    body: bodyBuffer
  };
}

async function ossServiceRequest({ method, query }) {
  const protocol = config.oss.secure === false ? 'http:' : 'https:';
  const requestUrl = `${protocol}//${config.oss.discoveryEndpoint}/${buildQueryString(query)}`;
  const date = new Date().toUTCString();
  const authorization = buildServiceAuthorization(method, date);

  const response = await fetch(requestUrl, {
    method,
    headers: {
      Date: date,
      Authorization: authorization
    }
  });

  const bodyBuffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw createOssError(response.status, bodyBuffer);
  }

  return {
    statusCode: response.status,
    body: bodyBuffer
  };
}

function buildQueryString(query) {
  if (!query) {
    return '';
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params.append(key, String(value));
  }

  const text = params.toString();
  return text ? `?${text}` : '';
}

function buildBucketAuthorization(bucketConfig, method, objectKey, date, contentType) {
  const canonicalizedResource = `/${bucketConfig.name}/${objectKey || ''}`;
  const stringToSign = [method, '', contentType || '', date, canonicalizedResource].join('\n');
  const signature = crypto.createHmac('sha1', config.oss.accessKeySecret).update(stringToSign).digest('base64');
  return `OSS ${config.oss.accessKeyId}:${signature}`;
}

function buildBucketSubresourceAuthorization(bucketConfig, method, objectKey, date, contentType, subresource) {
  const canonicalizedResource = `/${bucketConfig.name}/${objectKey || ''}?${subresource}`;
  const stringToSign = [method, '', contentType || '', date, canonicalizedResource].join('\n');
  const signature = crypto.createHmac('sha1', config.oss.accessKeySecret).update(stringToSign).digest('base64');
  return `OSS ${config.oss.accessKeyId}:${signature}`;
}

function buildServiceAuthorization(method, date) {
  const stringToSign = [method, '', '', date, '/'].join('\n');
  const signature = crypto.createHmac('sha1', config.oss.accessKeySecret).update(stringToSign).digest('base64');
  return `OSS ${config.oss.accessKeyId}:${signature}`;
}

function encodeObjectKey(key) {
  return String(key || '').split('/').map(encodeURIComponent).join('/');
}

function createOssError(statusCode, bodyBuffer) {
  const xmlText = bodyBuffer.toString('utf8');
  const error = new Error(extractXmlTag(xmlText, 'Message') || `OSS 请求失败，状态码 ${statusCode}`);
  error.status = statusCode;
  error.code = extractXmlTag(xmlText, 'Code') || '';
  error.requestId = extractXmlTag(xmlText, 'RequestId') || '';
  return error;
}

function extractXmlTag(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? match[1] : '';
}

function xmlDecode(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function decodeHeaderFilename(value) {
  if (!value) {
    return '';
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveStatusCode(error) {
  if (!error) {
    return 500;
  }
  if (typeof error.status === 'number') {
    return error.status;
  }
  if (typeof error.message === 'string' && error.message.includes('JSON 格式错误')) {
    return 400;
  }
  if (typeof error.message === 'string' && error.message.includes('文件过大')) {
    return 400;
  }
  if (typeof error.message === 'string' && error.message.includes('未找到 bucket')) {
    return 400;
  }
  return 500;
}
