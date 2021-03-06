/*
 * Require libraries
 */
var yargs = require('yargs');
var winston = require('winston');
var http = require("http");
var child_process = require('child_process');
var sleep = require('sleep');
var executable = require('executable');
var avconv = require('./libs/avconv/avconv');
var sources = require('./libs/sources');
var options = require('./libs/options');
var fs = require('fs');
var u = require('url');
var commandExists = require('command-exists');

/*
 * Define some global constants
 */
var STREAMING_RESTART_DELAY_SECONDS = 5;
var MINIMUM_BYTES_RECEIVED_SUCCESS = 4096;

/*
 * Read command line options
 */
var argv = yargs
		.usage('Usage: $0 -s <sources> [-a <avconv>] [-q | -v | -l]')
		.alias('l', 'listen')
		.alias('a', 'avconv')
		.alias('s', 'sources')
		.alias('q', 'quiet')
		.alias('v', 'verbose')
		.demand(['s'])
		.default('a', 'avconv')
		.default('l', '::')
		.describe('l', 'The address to listen on')
		.describe('a', 'The path to avconv, defaults to just "avconv"')
		.describe('s', 'The path to sources.json')
		.describe('q', 'Disable all logging to stdout')
		.describe('v', 'Enable verbose logging (shows the output from avconv)')
		.argv;

/*
 * Configure logger
 */
winston.remove(winston.transports.Console);

if (!argv.quiet)
{
	winston.add(winston.transports.Console, {
		timestamp: true,
		colorize: true,
		level: argv.verbose ? 'silly' : 'debug'
	});
}

/**
 * Configure the sources module
 */
var onSourceChange = function() {
	winston.info('Source definitions have changed, reloading ...');
};

var onParserError = function(error) {
	winston.info('Unable to read source definitions: %s', error.toString());
};

var onLoad = function(numSources) {
	winston.info('Loaded %d sources', numSources);
};

sources.load(argv.sources, 
	onSourceChange,
	onParserError,
	onLoad);

/**
 * Check that the avconv is useable 
 */
if (!argv.avconv) {
  argv.avconv = 'avconv';
}

commandExists(argv.avconv, function(err, exists) {
  if (!exists) {
    winston.error('avconv not found or is not executable');
    process.exit();
  }
});

/**
 * The main HTTP server process
 * @type @exp;http@call;createServer
 */
var serverCallback = function (request, response) {
	var remoteAddress = request.connection.remoteAddress;
	winston.debug('Got request for %s from %s', request.url, remoteAddress);

	// Find the source definition
	var exploded = u.parse(request.url, true);
	var source = sources.getByUrl(exploded.pathname);

	if (source === null)
	{
		winston.error('Unknown source %s', request.url);

		response.writeHead(404, {"Content-Type": "text/plain"});
		response.write("404 Not Found\n");
		response.end();

		return;
	}
	
	// Run eventual pre-script
	if (source.prescript)
	{
		winston.debug("Executing pre-script %s", source.prescript);
		runPrePostScript(source.prescript, [source.source, source.url, source.provider, source.name]);
	}

	// Tell the client we're sending MPEG-TS data
        var mimeType = 'video/mp2t';
        if (source.mime)
		mimeType = source.mime;
	response.writeHead(200, {
		'Content-Type': mimeType
	});

	if (source.script)
	{
		var soptions = {};
		if (source.file)
		{
			soptions.input = fs.readFileSync(source.file);
		}
		soptions.env = { "HTTP_HOST": request.headers["host"] };
		
		var result = child_process.spawnSync(source.script, soptions);
		response.write(result.stdout);
		winston.debug(result.stderr.toString());
		response.end();
		return;
	}

        if (source.file)
	{
		response.write(fs.readFileSync(source.file));
		response.end();
		return;
	}

	// Define options for the child process
	var avconvOptions = options.getInputAvconvOptions(source);
	if (exploded.query.duration)
		avconvOptions = avconvOptions.concat(['-t', exploded.query.duration]);
	avconvOptions = avconvOptions.concat(options.getOutputAvconvOptions(source));
	winston.debug("Options passed to avconv: " + avconvOptions);
	
	// Indicates whether avconv should be restarted on failure
	var shouldRestart = true;
	var stream = null;
	
	// Keep track of how much data has been pushed by avconv. We'll use this to determine whether streaming actually 
	// started successfully
	var bytesRecieved = 0;
	var streamingStarted = false;
	
	/**
	 * Spawns an avconv process and pipes its output to the response input
	 * @returns {undefined}
	 */
	var streamingLoop = function() {
		// Add "http_proxy" to the avconv environment if it is defined
		var environment = process.env;

		if (source.http_proxy) {
			environment.http_proxy = source.http_proxy;
		}
		
		// Determine the avconv binary to use
		var avconvBinary = argv.a;

		if (source.avconv) {
			avconvBinary = source.avconv;
		}
		
		stream = avconv(avconvOptions, avconvBinary, environment);
		stream.pipe(response);

		// Kill the process on error
		stream.on('error', function() {
			stream.kill();
		});
		
		// Print avconv status messages
		stream.on('message', function(message) {
			winston.silly(message);
			bytesRecieved += message.length;
			
			// Check if streaming seems to have started
			if (bytesRecieved >= MINIMUM_BYTES_RECEIVED_SUCCESS && !streamingStarted) {
				winston.info('avconv started successfully');
				streamingStarted = true;
			}
		});

		// Respawn on exit
		stream.on('exit', function(code) {
			streamingStarted = false;
			var message = 'avconv exited with code %d';
			
			// Don't log normal exits as errors. 255 happens when the client presses stop.
			if (code !== 0 && code !== 255) {
				winston.error(message, code);
			} else {
				winston.debug(message, code);
			}
			
			if (shouldRestart && code !== 0)
			{
				winston.info('%s still connected, restarting avconv after %d seconds ...', remoteAddress,
					STREAMING_RESTART_DELAY_SECONDS);

				// Throttle restart attempts, otherwise it will try to respawn as fast as possible
				sleep.sleep(STREAMING_RESTART_DELAY_SECONDS);
				streamingLoop();
			} else {
				response.end();
 			}
		});
	};
	
	// Start serving data
	streamingLoop();
	
	// Kill avconv when client closes the connection
	request.on('close', function () {
		winston.info('%s disconnected, stopping avconv', remoteAddress);
		
		shouldRestart = false;
		stream.kill();
		
		// Run eventual post-script
		if (source.postscript)
		{
			winston.debug("Executing post-script %s", source.postscript);
			runPrePostScript(source.postscript, [source.source, source.url, source.provider, source.name]);
		}
	});
};

/**
 * Runs the specified script with the specified parameters.
 *
 * @param scriptPath
 * @param params
 */
var runPrePostScript = function(scriptPath, params) {
	try {
		if (executable.sync(scriptPath)) {
			child_process.spawnSync(scriptPath, params);
		} else {
			winston.error("The specified script is not executable");
		}
	}
	catch (e) {
		winston.error("The specified script doesn't exist");
	}
};

// Start the server (must listen on both 80 and 5004)
var server1 = http.createServer(serverCallback);
var server2 = http.createServer(serverCallback);
server1.listen(80, argv.l);
server2.listen(5004, argv.l);
winston.info('Server listening on ports 80 and 5004');
