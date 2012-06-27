// USAGE: node app.js <clientID> <clientSecret> [exampleHost] [apiHost]

var express = require('express');
var querystring = require('querystring');
var request = require('request');
var sprintf = require('sprintf').sprintf;
var OAuth2 = require('oauth').OAuth2;
var sqlite3 = require('sqlite3').verbose();
var async = require ('async');

//large number to avoid limit on crimes
var bigNumber = 100;

//bounding box consts
var latConst = 0.000101784;
var lngConst = 0.000300407;

// The port that this express app will listen on
var port = 8043;

// Your client ID and secret from http://dev.singly.com/apps
var clientId = process.argv[2] || 'b8251190c2d5116f88f4930062a4ca0c';
var clientSecret = process.argv[3] || 'f073715ed9def9186b1463befcace1fe';

var hostBaseUrl = process.argv[4] || 'http://localhost:' + port;
var apiBaseUrl = process.argv[5] || 'https://api.singly.com';
var crimeSpottingUrl = 'http://sanfrancisco.crimespotting.org/crime-data';

var ebkey = 'aQkRJjUKPcdtRfA';

var crimeWeights = { 
 "MURDER" : 13,
 "ARSON": 12,
 "AGGRAVATED ASSAULT": 11,
 "VEHICLE THEFT": 10,
 "ROBBERY": 9,
 "BURLGARY": 8,
 "SIMPLE ASSAULT": 7,
 "THEFT": 6,
 "VANDALISM": 5,
 "PROSTITUTION": 4,
 "ALCOHOL": 3,
 "NARCOTICS": 2,
 "DISTURBING THE PEACE": 1
};

var db = new sqlite3.Database(":memory:");

// Pick a secret to secure your session storage
var sessionSecret = '42';

var usedServices = [
  'Facebook',
  'foursquare',
  'Instagram',
  'Tumblr',
  'Twitter',
  'LinkedIn',
  'FitBit',
  'Email'
];

var oa = new OAuth2(clientId, clientSecret, apiBaseUrl);

// A convenience method that takes care of adding the access token to requests
function getProtectedResource(path, session, callback) {
  oa.getProtectedResource(apiBaseUrl + path, session.access_token, callback);
}

// Given the name of a service and the array of profiles, return a link to that
// service that's styled appropriately (i.e. show a link or a checkmark).
function getLink(prettyName, profiles, token) {
  var service = prettyName.toLowerCase();

  // If the user has a profile authorized for this service
  if (profiles && profiles[service] !== undefined) {
    // Return a unicode checkmark so that the user doesn't try to authorize it again
    return sprintf('<span class="check">&#10003;</span> <a href="%s/services/%s?access_token=%s">%s</a>', apiBaseUrl, service, token, prettyName);
  }

  // This flow is documented here: http://dev.singly.com/authorization
  var queryString = querystring.stringify({
    client_id: clientId,
      redirect_uri: sprintf('%s/callback', hostBaseUrl),
      service: service
  });

  return sprintf('<a href="%s/oauth/authorize?%s">%s</a>',
      apiBaseUrl,
      queryString,
      prettyName);
}

// Create an HTTP server
var app = express.createServer();

// Setup for the express web framework
app.configure(function() {
  app.use(express.logger());
  app.use(express.static(__dirname + '/public'));
  app.use(express.bodyParser());
  app.use(express.cookieParser());
  app.use(express.session({
    secret: sessionSecret
  }));
  app.use(app.router);
  app.set('view options', {
  layout: true
});
});

// We want exceptions and stracktraces in development
app.configure('development', function() {
  app.use(express.errorHandler({
    dumpExceptions: true,
    showStack: true
  }));
});

// ... but not in production
app.configure('production', function() {
  app.use(express.errorHandler());
});

// Use ejs instead of jade because HTML is easy
app.set('view engine', 'ejs');

app.get('/', function(req, res) {
  var i;
  var services = [];

  // For each service in usedServices, get a link to authorize it
  for (i = 0; i < usedServices.length; i++) {
    services.push({
      name: usedServices[i],
      link: getLink(usedServices[i], req.session.profiles, req.session.access_token)
    });
  }

  // Render out views/index.ejs, passing in the array of links and the session
  res.render('index', {
    services: services,
    session: req.session
  });
});

app.get('/callback', function(req, res) {
  var data = {
    client_id: clientId,
  client_secret: clientSecret,
  code: req.param('code')
  };

  // Exchange the OAuth2 code for an access_token
  request.post({
    uri: sprintf('%s/oauth/access_token', apiBaseUrl),
    body: querystring.stringify(data),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }, function (err, resp, body) {
    try {
      body = JSON.parse(body);
    } catch(parseErr) {
      return res.send(parseErr, 500);
    }

    // Save the access_token for future API requests
    req.session.access_token = body.access_token;

    // Fetch the user's service profile data
    getProtectedResource('/profiles', req.session, function(err, profilesBody) {
      try {
        profilesBody = JSON.parse(profilesBody);
      } catch(parseErr) {
        return res.send(parseErr, 500);
      }

      req.session.profiles = profilesBody;

      res.redirect('/');
    });
  });
});

//function to get all checkins
app.get('/crimescore.json', function(req, res) {
	getProtectedResource('/types/checkins', req.session, function(err, checkinsBody) {
		try {
			checkinsBody = JSON.parse(checkinsBody);
    	}
    	catch(parseErr) {
			return res.send(parseErr, 500);
    	}
		var checkins = [];
		checkinsBody.forEach(function(datum) {
			checkins.push(datum.oembed);
		});
	    getCrimeScore(checkins, function (score) {
			res.json( { "crimeScore": score} );
		});
	});
});

function getBB(oembed) {
  lat = oembed.lat;
  lat1 = lat-latConst;
  lat2 = lat+latConst;
  lon = parseFloat(oembed.lng);
  lon1 = lon-lonConst;
  lon2 = lon+lonConst;
  console.log(lon);
  return lat1+','+lon1+","+lat2+","+lon2;
}


function getCrimeScore(checkins, cb){
	var crimeScore = 0;
	async.forEachSeries(checkins, function(item, callback) {
		var north = item.lat + latConst;
		var south = item.lat - latConst;
		var east = item.lng + lngConst;
		var west = item.lng -lngConst;
		var cpoints;
		db.get("SELECT SUM(weight) as crimePoints FROM crimes WHERE lng < " +east + " AND lng > " +west + " AND lat < " + north + " AND lat > " + south, function(err, row){
			temp = row.crimePoints;
			crimeScore = crimeScore + temp;
			console.log("another crime!: " + crimeScore + "(PS, temp: " +temp+")");
			callback();
		});
	}, function(err) {
		console.log("crime score: " + crimeScore);
		cb(crimeScore/checkins.length);
	});
}





function populateDatabase() {
  db.serialize(function() {
    db.run("CREATE TABLE crimes (lat REAL, lng REAL, weight INTEGER)");
  });
  var currentDate = new Date();
  var start = new Date();
  start.setMonth(currentDate.getMonth() - 4);
  var end = new Date();
  end.setMonth(currentDate.getMonth() - 1);

  var uri = 'http://sanfrancisco.crimespotting.org/crime-data?format=json&count=' + bigNumber + '&dstart=' + start.toISOString().substr(0,10) + '&dend=' + end.toISOString().substr(0,10);
	console.log(uri);    
	request.get(uri, function (err, resp, js){
		js = JSON.parse(js);
		js.features.forEach( function (feature) {
        	db.run("INSERT into crimes VALUES (?, ?, ?)", feature.geometry.coordinates[1], feature.geometry.coordinates[0], crimeWeights[feature.properties.crime_type]);
    	});
		db.each("SELECT * FROM crimes", function(err, row){
			console.log(row);
		});
	});
}

populateDatabase();


app.listen(port);

console.log(sprintf('Listening at %s using API endpoint %s.', hostBaseUrl, apiBaseUrl));
