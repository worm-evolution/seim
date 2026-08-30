const express = require('express');
const cors = require('cors');
const path = require('path');
const { seim } = require('seim-core');

const app = express();
const PORT = 3005;

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3005' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Initialize Mock Databases Globally for VM Sandbox Access
global.products = Array.from({ length: 1000 }, (_, i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  price: Math.floor(Math.random() * 1000) + 10,
  category: ['electronics', 'clothing', 'food', 'books'][Math.floor(Math.random() * 4)],
  stock: Math.floor(Math.random() * 100),
  rating: (Math.random() * 5).toFixed(1),
  description: `This is product ${i + 1} with various features`
}));

global.users = Array.from({ length: 500 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
  orders: Math.floor(Math.random() * 50),
  totalSpent: Math.floor(Math.random() * 10000),
  segment: ['premium', 'regular', 'trial'][Math.floor(Math.random() * 3)]
}));

// 2. Initialize SEIM Configuration (Production Configurations with File Storage)
const seimConfig = {
  // This demo intentionally exercises the full automatic promotion loop.
  // Production deployments should leave this false and approve candidates manually.
  autonomousPromotion: true,
  mode: 'bypass',
  environment: 'production',
  framework: 'express',
  storagePath: path.join(__dirname, '.seim-storage'),
  businessRules: [],
  securityRules: [],
  ai: {
    generatorModel: 'gemini-2.0-flash',
    reviewerModel: 'gemini-2.0-flash',
    verifierModel: 'gemini-2.0-flash',
    provider: 'google',
    apiKey: process.env.GEMINI_API_KEY || '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    enabled: true
  },
  experiment: {
    confidenceThreshold: 0.95,
    canaryPercent: 100,
    rollbackLatencyMs: 2000,
    rollbackErrorRate: 0.05,
    minSampleSize: 1,
    shadowCooldownMs: 0,
    shadowAllowedMethods: ['GET'],
    shadowSampleSize: 1,
    sandboxTimeoutMs: 5000
  },
  storage: {
    type: 'file'
  },
  learning: {
    enabled: true,
    sampleSize: 1
  },
  worker: {
    enabled: true,
    intervalMs: 100,
    batchSize: 5
  },
  evolution: {
    enabled: true,
    maxGenerations: 5,
    populationSize: 4,
    mutationRate: 0.2,
    crossoverRate: 0.3,
    driftDetection: true
  },
  logging: {
    level: 'debug'
  },
  build: {
    enabled: false
  }
};

const seimInstance = seim(seimConfig);
app.use(seimInstance.listener());

// 3. Queue to store lifecycle events for the UI Dashboard
const eventLogs = [];
const eventTypes = [
  'optimization:detected',
  'optimization:validated',
  'optimization:promoted',
  'optimization:rejected',
  'optimization:rolledback',
  'optimization:explained',
  'shadow:started',
  'shadow:completed',
  'health:degraded',
  'health:recovered',
  'error:sandbox',
  'error:validation',
  'error:internal'
];

for (const eventName of eventTypes) {
  seimInstance.on(eventName, (payload) => {
    eventLogs.push({
      timestamp: new Date().toLocaleTimeString(),
      event: eventName,
      payload
    });
    if (eventLogs.length > 50) eventLogs.shift();
  });
}

// 4. Mutable Route Handlers Definitions
async function fastHandler(req, res) {
  const totalRevenue = global.users.reduce((sum, u) => sum + u.totalSpent, 0);
  const averageOrderValue = totalRevenue / global.users.reduce((sum, u) => sum + u.orders, 0);
  const topProducts = global.products
    .slice(0, 5)
    .map(p => ({
      ...p,
      revenue: (p.id * 150) % 10000
    }))
    .sort((a, b) => b.revenue - a.revenue);
  
  res.json({
    metrics: {
      totalRevenue,
      averageOrderValue,
      totalUsers: global.users.length,
      totalProducts: global.products.length
    },
    topProducts
  });
}

async function slowHandler(req, res) {
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  await delay(600);
  await delay(600);
  const totalRevenue = global.users.reduce((sum, u) => sum + u.totalSpent, 0);
  const averageOrderValue = totalRevenue / global.users.reduce((sum, u) => sum + u.orders, 0);
  const topProducts = global.products
    .slice(0, 5)
    .map(p => ({
      ...p,
      revenue: (p.id * 150) % 10000
    }))
    .sort((a, b) => b.revenue - a.revenue);
  
  res.json({
    metrics: {
      totalRevenue,
      averageOrderValue,
      totalUsers: global.users.length,
      totalProducts: global.products.length
    },
    topProducts
  });
}

// Register initial route handler
app.get('/api/analytics/dashboard', fastHandler);

// 5. Utility function to dynamically hot-swap route handlers in Express router stack
function setRouteHandler(path, method, handler) {
  const routeLayer = app._router.stack.find(
    layer => layer.route && layer.route.path === path && layer.route.methods[method]
  );
  if (routeLayer) {
    const handlerLayer = routeLayer.route.stack.find(l => l.method === method);
    if (handlerLayer) {
      handlerLayer.handle = handler;
      return true;
    }
  }
  return false;
}

// Helper to check what handler is active
function getRouteHandlerName(path, method) {
  const routeLayer = app._router.stack.find(
    layer => layer.route && layer.route.path === path && layer.route.methods[method]
  );
  if (routeLayer) {
    const handlerLayer = routeLayer.route.stack.find(l => l.method === method);
    if (handlerLayer) {
      return handlerLayer.handle.name;
    }
  }
  return 'unknown';
}

// 6. Developer control endpoints for dashboard interaction
app.post('/api/seim/trigger-pattern', (req, res) => {
  const { pattern } = req.body;
  if (pattern === 'sequential-async') {
    setRouteHandler('/api/analytics/dashboard', 'get', slowHandler);
    // Reset optimizer endpoints status so it checks it again
    if (seimInstance.endpointTracker) {
      seimInstance.endpointTracker.resetRoute('/api/analytics/dashboard');
    }
    return res.json({ success: true, activeHandler: 'slowHandler (Sequential Delay Injected)' });
  } else if (pattern === 'restore-fast') {
    setRouteHandler('/api/analytics/dashboard', 'get', fastHandler);
    if (seimInstance.endpointTracker) {
      seimInstance.endpointTracker.resetRoute('/api/analytics/dashboard');
    }
    // Also rollback the active version in SEIM rollback manager
    if (seimInstance.rollback) {
      seimInstance.rollback.rollbackRoute('/api/analytics/dashboard');
    }
    return res.json({ success: true, activeHandler: 'fastHandler (Restored Baseline)' });
  }
  res.status(400).json({ error: 'Invalid pattern name' });
});

// Endpoint to fetch SEIM diagnostics
app.get('/api/seim/status', (req, res) => {
  try {
    const status = seimInstance.status();
    res.json({
      ...status,
      activeHandler: getRouteHandlerName('/api/analytics/dashboard', 'get')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/seim/metrics', (req, res) => {
  try {
    res.json(seimInstance.metrics.snapshot());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/seim/endpoints', (req, res) => {
  try {
    res.json(seimInstance.endpointTracker ? seimInstance.endpointTracker.getAllStatuses() : []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/seim/events', (req, res) => {
  res.json(eventLogs);
});

// Standard Business API Endpoints
app.get('/api/products', (req, res) => {
  res.json(global.products.slice(0, 50));
});

app.get('/api/users', (req, res) => {
  res.json(global.users.slice(0, 50));
});

// Start server
app.listen(PORT, () => {
  console.log(`Demo app backend running at http://localhost:${PORT}`);
});
