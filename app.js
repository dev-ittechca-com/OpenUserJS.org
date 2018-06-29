'use strict';

// Define some pseudo module globals
var isPro = require('./libs/debug').isPro;
var isDev = require('./libs/debug').isDev;
var isDbg = require('./libs/debug').isDbg;

// Stamp a message for stdout...
console.log('Starting application...');

//  ... and stderr
if (isPro) {
  console.warn('Starting application...');
}

//
var path = require('path');
var crypto = require('crypto');

var express = require('express');
var toobusy = require('toobusy-js-harmony');
var statusCodePage = require('./libs/templateHelpers').statusCodePage;

var methodOverride = require('method-override');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var compression = require('compression');
var favicon = require('serve-favicon');

var minify = require('express-minify');
var uglifyjs = require('uglify-js');

var lessMiddleware = require('less-middleware');

var session = require('express-session');
var MongoStore = require('connect-mongo')(session);
var mongoose = require('mongoose');
mongoose.Promise = global.Promise;

var passport = require('passport');
var colors = require('ansi-colors');

var request = require('request');

//
var pingCertTimer = null;

var app = express();

var modifySessions = require('./libs/modifySessions');

var settings = require('./models/settings.json');

var connectStr = process.env.CONNECT_STRING || settings.connect;
var sessionSecret = process.env.SESSION_SECRET || settings.secret;
var db = mongoose.connection;

var dbOptions = {};
if (isPro) {
  dbOptions = {
    secondaryAcceptableLatencyMS: 15,
    poolSize: 5
  }
} else {
  dbOptions = {
    poolSize: 5,
    reconnectTries: 30,
    reconnectInterval: 1000
  }
}

var fs = require('fs');
var http = require('http');
var https = require('https');
var sslOptions = null;
var server = http.createServer(app);
var secureServer = null;
var privkey = './keys/private.key';
var fullchain = './keys/cert.crt';
var chain = './keys/intermediate.crt';
var secured = null;

app.set('port', process.env.PORT || 8080);
app.set('securePort', process.env.SECURE_PORT || null);

// Connect to the database
mongoose.connect(connectStr, dbOptions);

// Trap a few events for MongoDB
db.on('error', function () {
  console.error(colors.red('MongoDB connection error'));
});

db.once('open', function () {
  console.log(colors.green('MongoDB connection is opened'));
});

db.on('connected', function () {
  var admin = new mongoose.mongo.Admin(mongoose.connection.db);
  admin.buildInfo(function (aErr, aInfo) {
    console.log(colors.green('Connected to MongoDB v' + aInfo.version));
  });
});

db.on('disconnected', function () {
  console.error(colors.yellow('\nMongoDB connection is disconnected'));
});

db.on('reconnected', function () {
  console.error(colors.yellow('MongoDB connection is reconnected'));
});

function beforeExit() {
  /**
   * Attempt to get everything closed before process exit
   */

  // Cancel any intervals
  if (pingCertTimer) {
    clearInterval(pingCertTimer);
  }

  // Close the db connection
  db.close(); // NOTE: Current asynchronous but auth may prevent callback until completed

  // Stop serving new http connections
  server.close(); // NOTE: Currently asynchronous but auth may prevent callback until completed

  // Shutdown timer in toobusy
  toobusy.shutdown(); // NOTE: Currently synchronous
}

process.on('SIGINT', function () {
  console.log(colors.green('\nCaptured app termination'));

  beforeExit(); // NOTE: Event not triggered for direct `process.exit()`

  // Terminate the app
  process.exit(0);
});

var sessionStore = new MongoStore({
  mongooseConnection: db,
  autoRemove: 'interval',
  autoRemoveInterval: (6 / 2) * 60 // In minutes. Default 10
});

// See https://hacks.mozilla.org/2013/01/building-a-node-js-server-that-wont-melt-a-node-js-holiday-season-part-5/
var ensureIntegerOrNull = require('./libs/helpers').ensureIntegerOrNull;

var maxLag = ensureIntegerOrNull(process.env.BUSY_MAXLAG) || 70;
var pollInterval = ensureIntegerOrNull(process.env.BUSY_INTERVAL) || 500;

toobusy.maxLag(maxLag);
toobusy.interval(pollInterval);

if (isDbg) {
  toobusy.onLag(function(aCurrentLag) {
    console.warn('Event loop lag detected! Latency:', aCurrentLag + 'ms');
  });
}

var hostMaxMem = ensureIntegerOrNull(process.env.HOST_MAXMEM_BYTES) || 1073741824; // 1GiB default
var maxMem = ensureIntegerOrNull(process.env.BUSY_MAXMEM) || 50; // 50% default

var forceBusyAbsolute = process.env.FORCE_BUSY_ABSOLUTE === 'true';
var forceBusy = process.env.FORCE_BUSY === 'true';

app.use(function (aReq, aRes, aNext) {
  var pathname = aReq._parsedUrl.pathname;
  var referer = aReq.headers.referer || '';
  var usedMem = null;
  var isSources = null;

  // Midddlware options
  if (!aRes.oujsOptions) {
    aRes.oujsOptions = {};
  }

  // Middleware for DNT
  aRes.oujsOptions.DNT = aReq.get('DNT') === '1' || aReq.get('DNT') === 'yes' ? true : false;

  // Middleware for GDPR Notice
  aRes.oujsOptions.hideReminderGDPR =
    /^https?:\/\/(?:localhost:8080|openuserjs\.org)/.test(referer);

  //
  if (
    /^\/favicon\.ico$/.test(pathname) ||
      /^\/redist\//.test(pathname) ||
        /^\/less\//.test(pathname) ||
          /^\/css\//.test(pathname) ||
            /^\/images\//.test(pathname) ||
              /^\/fonts\//.test(pathname) ||
                /^\/meta\//.test(pathname) ||
                  /^\/github\//.test(pathname) ||
                    /^\/logout\/?/.test(pathname) ||
                      /^\/auth\//.test(pathname) ||
                        /^\/(?:admin|mod)/.test(pathname) ||
                          /^\/api\/user\/exist\//.test(pathname)

  ) {
    aNext(); // NOTE: Allow to pass through on these routes
    return;
  }

  if (forceBusyAbsolute) { // Always busy
    aRes.status(503).send(); // NOTE: No UI period just response header
    return;

  } else if (forceBusy) { // Graceful busy
    statusCodePage(aReq, aRes, aNext, {
      statusCode: 503,
      statusMessage:
        'We are experiencing technical difficulties right now. Please try again later.'
    });
    return;

  } else {
    isSources = /^\/(?:install|src|scripts\/.*\/source\/?$)/.test(pathname);

    if (isSources) {
      // Calculate current whole percentage of RSS memory used
      usedMem = parseInt(process.memoryUsage().rss / hostMaxMem * 100);

      // Compare current RSS memory percentage used to maximum percentage
      if (usedMem > maxMem) {
        statusCodePage(aReq, aRes, aNext, {
          statusCode: 503,
          statusMessage: 'We are very busy right now\u2026 Please try again later.'
        });
        return;
      }
    }

    if (toobusy()) { // check if toobusy
      statusCodePage(aReq, aRes, aNext, {
        statusCode: 503,
        statusMessage: 'We are very busy right now. Please try again later.'
      });
      return;
    } else {
      aNext(); // not toobusy
      // fallthrough
    }
  }
});

// Force HTTPS
secured = true;
try {
  fs.accessSync(privkey, fs.constants.F_OK);
  fs.accessSync(fullchain, fs.constants.F_OK);
  fs.accessSync(chain, fs.constants.F_OK);
} catch (aE) {
  secured = false;
}

if (app.get('securePort') && secured) {
  sslOptions = {
    key: fs.readFileSync(privkey),
    cert: fs.readFileSync(fullchain),
    ca: fs.readFileSync(chain),
    ciphers: [
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'DHE-RSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-SHA256',
      'DHE-RSA-AES128-SHA256',
      'ECDHE-RSA-AES256-SHA384',
      'DHE-RSA-AES256-SHA384',
      'ECDHE-RSA-AES256-SHA256',
      'DHE-RSA-AES256-SHA256',
      'HIGH',
      '!aNULL',
      '!eNULL',
      '!EXPORT',
      '!DES',
      '!RC4',
      '!MD5',
      '!PSK',
      '!SRP',
      '!CAMELLIA'
    ].join(':'),
    honorCipherOrder: true,
    secureOptions: crypto.constants.SSL_OP_NO_TLSv1
  };
  secureServer = https.createServer(sslOptions, app);

  app.use(function (aReq, aRes, aNext) {
    aRes.setHeader('Strict-Transport-Security',
      'max-age=31536000000; includeSubDomains');

    if (!aReq.secure) {
      aRes.redirect(301, 'https://' + aReq.headers.host + encodeURI(aReq.url));
      return;
    }

    aNext();
  });

  server.listen(app.get('port'));
  secureServer.listen(app.get('securePort'));
} else {
  server.listen(app.get('port'));
}

if (isDev || isDbg) {
  app.use(morgan('dev'));
} else if (process.env.FORCE_MORGAN_PREDEF_FORMAT) {
  app.use(morgan(process.env.FORCE_MORGAN_PREDEF_FORMAT));
}

app.use(bodyParser.urlencoded({
  extended: false,
  limit: parseInt(settings.maximum_upload_script_size / 1024, 10) + 'kb'
}));

app.use(bodyParser.json({
  extended: false,
  limit: parseInt(settings.maximum_upload_script_size / 1024, 10) + 'kb'
}));

app.use(compression());
app.use(methodOverride('X-HTTP-Method-Override'));

// Add absent from server MIME Content Type for peg grammar files
express.static.mime.define({
  'text/x-pegjs':  ['pegjs']
});

// Order is very important here (i.e mess with at your own risk)
app.use(passport.initialize());
app.use(session({
  resave: false,
  saveUninitialized: false,
  unset: 'destroy',
  cookie: {
    maxAge: 5 * 60 * 1000, // minutes in ms NOTE: Expanded after successful auth
    secure: (isPro && secured ? true : false),
    sameSite: 'lax' // NOTE: OpenID necessity
  },
  rolling: true,
  secret: sessionSecret,
  store: sessionStore
}));
app.use(function (aReq, aRes, aNext) {
  if (aReq.session[passport._key]) {
    // load data from existing session
    aReq._passport.session = aReq.session[passport._key];
  }
  aNext();
});
app.use(modifySessions.init(sessionStore));

app.use(favicon(__dirname + '/public/images/favicon.ico'));

// Set up the views
app.engine('html', require('./libs/muExpress').renderFile(app));
app.set('view engine', 'html');
app.set('views', __dirname + '/views');


// Setup minification
// Order is important here as Ace will fail with an invalid content encoding issue
var minifyErrorHandler = function (aErr, aCallback) {
  console.warn([ // NOTE: Pushing this to stderr instead of default stdout
    'MINIFICATION WARNING (release):',
    '  filename: ' + aErr.filename,
    '  message: ' + aErr.message,
    '  line: ' + aErr.line + ' col: ' + aErr.col + ' pos: ' + aErr.pos,
    '  body: ' + aErr.body.slice(0, 200)

  ].join('\n'));

  if (aErr && aErr.stage === 'compile') {
    aCallback(aErr.error, JSON.stringify(aErr.error));
    return;
  }

  aCallback(aErr.error, aErr.body);

};

app.use(minify({
  uglifyJsModule: uglifyjs,
  cache: './dev/cache/express-minify/release',
  onerror: minifyErrorHandler
}));

app.use(function(aReq, aRes, aNext) {
  var pathname = aReq._parsedUrl.pathname;

  // If a userscript or library...
  if (
    (/(\.user)?\.js|\.meta.js(on)?$/.test(pathname) && /^\/(meta|install|src)\//.test(pathname)) ||
      /^\/admin\/(npm|json)/.test(pathname) ||
        /^\/mod\/removed\//.test(pathname)
  ) {
    aRes.minifyOptions = aRes.minifyOptions || {}; // Ensure object exists on response
    aRes.minifyOptions.minify = false; // Skip using release minification because we control this with *uglify-es*
  }
  aNext();
});

app.use(lessMiddleware(__dirname + '/public', {
  render: {
    compress: false,
    paths: [
      path.join(__dirname, 'node_modules/bootstrap/less')
    ]
  }
}));

// Routes
require('./routes')(app);


// Timers
function tripServerOnCertExpire(aValidToString) {
  var tlsDate = new Date(aValidToString);
  var nowDate = new Date();

  var tripDate = new Date(tlsDate.getTime() - (2 * 60 * 60 * 1000)); // ~2 hours before fault

  if (nowDate.getTime() >= tripDate.getTime()) {
    console.warn(colors.red('Attempting server restart'));
    try {
      fs.renameSync(privkey, privkey + '.expired')
      fs.renameSync(fullchain, fullchain + '.expired');
      fs.renameSync(chain, chain + '.expired');

      console.warn(colors.red('TLS (SSL) EXPIRING VERY SOON... TRIPPING SERVER TO HTTP!'));

      beforeExit(); // NOTE: Event not triggered for direct `process.exit()`

      process.exit(1);

    } catch (aE) {
      // noop
    }
  }
}

function pingCert() {
  request({
    method: 'HEAD',
    // NOTE: Use localhost to avoid firewall and unnecessary traffic
    url: (isPro && app.get('securePort') ? 'https' : 'http') + '://localhost' +
      (isPro && app.get('securePort')
        ? ':' + app.get('securePort')
        : ':' + app.get('port'))
          + '/api'
  }, function (aErr, aRes, aBody) {
    if (aErr) {
      if (aErr.cert) {
        // Encryption available with Error thrown since internal TLS request on localhost
        // isn't usually a valid registered domain however external requests can be blocked by
        // browsers as well as false credentials supplied

        // Test for time limit of expiration
        tripServerOnCertExpire(aErr.cert.valid_to);

      } else {
        console.warn([
          colors.red(aErr),
          colors.red('Server may not be running on specified port or port blocked by firewall'),
          colors.red('Encryption not available')

        ].join('\n'));
      }
      return;
    }

    if (aRes.req.connection.getPeerCertificate) {
      // Encryption available
      // NOTE: Server blocks this currently
      console.warn(colors.red('Firewall pass-through detected'));

      // Test for time limit of expiration
      tripServerOnCertExpire(aRes.req.connection.getPeerCertificate().valid_to);

    } else {
      console.warn(colors.yellow('Encryption not available'));
    }
  });
};

if (secured) {
  pingCertTimer = setInterval(pingCert, 60 * 60 * 1000); // NOTE: Check every hour
}
