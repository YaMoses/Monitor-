/*
 *  worker-realted tasks
 *
 * */

 // Dependencies 
 var path = require('path');
 var fs = require('fs');
 var _data = require('./data');
 var https = require('https');
 var http = require('http');
 var helpers = require('./helpers');
 var url = require('url');


 // Instantiate the worker object 
 var workers = {};

 // Lookup all checks, get their data, send to a validator 
 workers.gatherAllChecks = function(){
     // Get all the checks 
     _data.list('checks',function(err,checks){
         if (!err && checks && checks.length > 0) {
             checks.forEach(function(check){
                 // Read in the check data 
                 _data.read('checks', check, function(err, originalCheckData){
                    if (!err && originalCheckData) {
                        // Pass it to the check validator, and let that function continue or log errors as needed
                        workers.validateCheckData(originalCheckData);
                    } else {
                        console.log("Error reading one of the checks data");
                    }
                 });
             });
         } else {
             console.log("Error: Could not find any checks to process");
         }
     });
 };

 // Sanity-check the check-data
 workers.validateCheckData = function(originalCheckData){
    originalCheckData = typeof(originalCheckData) == 'object' && originalCheckData !== null ? originalCheckData : {};
    originalCheckData.id =typeof(originalCheckData.id) == 'string' && originalCheckData.id.trim().length == 20 ? originalCheckData.id.trim() : false; 
    originalCheckData.userPhone  =typeof(originalCheckData.userPhone) == 'string' && originalCheckData.userPhone.trim().length == 10 ? originalCheckData.userPhone.trim() : false;
    originalCheckData.protocol  =typeof(originalCheckData.protocol) == 'string' && ['http','https'].indexOf(originalCheckData.protocol) > -1 ? originalCheckData.protocol : false;
    originalCheckData.url  = typeof(originalCheckData.url) == 'string' && originalCheckData.url.trim().length > 0 ? originalCheckData.url.trim() : false;
    originalCheckData.method    = typeof(originalCheckData.method) == 'string' && ['post','get','put','delete'].indexOf(originalCheckData.method) > -1 ? originalCheckData.method : false;
    originalCheckData.successCodes  = typeof(originalCheckData.successCodes) == 'object' && originalCheckData.successCodes instanceof Array &&  originalCheckData.successCodes.length > 0 ? originalCheckData.successCodes : false;
    originalCheckData.timeOutSeconds  = typeof(originalCheckData.timeOutSeconds) == 'number' && originalCheckData.timeOutSeconds % 1 === 0 && originalCheckData.timeOutSeconds >= 1 && originalCheckData.timeOutSeconds <= 5  ? originalCheckData.timeOutSeconds : false;

    // Set the keys that may not be set if the worker have never seen this checks before 
    originalCheckData.state = typeof(originalCheckData.protocol) == 'string' && ['Up','Down'].indexOf(originalCheckData.state) > -1 ? originalCheckData.state : 'down  ';
    originalCheckData.lastChecked  = typeof(originalCheckData.lastChecked) == 'number' && originalCheckData.lastChecked > 0 ? originalCheckData.lastChecked : false;

    // If all the checks pass, pass the data along to the next step in the process
    if(originalCheckData.id &&
        originalCheckData.userPhone &&
        originalCheckData.protocol && 
        originalCheckData.url && 
        originalCheckData.method && 
        originalCheckData.successCodes &&
        originalCheckData.timeOutSeconds) {
            workers.performCheck(originalCheckData);
        } else {
            console.log("Error: One of the checks is not properly formatted. Skipping it."); 
        }
 };

 // Perform the check, send the originalCheckData and the outcome of the check protocol
 workers.performCheck = function(originalCheckData){
     // Prepare the initial check outcome 
     var checkOutcome = {
         'error' : false,
         'responseCode' : false
     };

     // Mark that the outcome has not been sent yet 
     var outComeSent = false;

     // Parse the hostname and the path out of the original check data 
     var parseUrl = url.parse(originalCheckData.protocol+'://'+originalCheckData.url,true);
     var hostName = parseUrl.hostname;
     var path = parseUrl.path; // Using path and not "pathname" because we want the query string 

     // Construct the request 
     var requestDetails = {
         'protocol' : originalCheckData.protocol+':',
         'hostname' : hostName,
         'method'   : originalCheckData.method.toUpperCase(),
         'path'     : path,
         'timeout'  : originalCheckData.timeOutSeconds * 1000
     };

     // Instantiate the request object using either the http or https module
     var _moduleToUse = originalCheckData.protocol == 'http' ? http : https;
     var req = _moduleToUse.request(requestDetails, function(res){
         // Grab the status of the sent request 
         var status = res.statusCode;

         // Update the checkOutcome and pass the data along 
         checkOutcome.responseCode = status;
         if (!outComeSent) {
             workers.processCheckOutcome(originalCheckData,checkOutcome);
             outComeSent = true;
         }
     });

     // Bind to the error event so it doesn't get thrown 
     req.on('error',function(e){
         // Update the checkOutcome and pass the data along 
         checkOutcome.error = {
             'error' : true,
             'value' : e
         };
         if (!outComeSent) {
             workers.processCheckOutcome(originalCheckData,checkOutcome);
             outComeSent = true;
         }
     });

     // End the request 
     req.end();
 };

 // Process the check Outcome, update the check data as needed, trigger an alert to the user 
 // Special logic for accomodating a check that has never been tested before (don't alert on that one)

 workers.processCheckOutcome = function(originalCheckData, checkOutcome){

    // Decide if the check is considered up or down 
    var state = !checkOutcome.error && checkOutcome.responseCode && originalCheckData.successCodes.indexOf(checkOutcome.responseCode) > -1 ? 'up' : 'down';

    // Decide if an alert is warranted 
    var alertWarranted = originalCheckData.lastChecked && originalCheckData.state !== state ? true : false;

    // Log the outcome 
    var timeOfCheck = Date.now();
    workers.log(originalCheckData,checkOutcome,state,alertWarranted,timeOfCheck);

    // Update the check data 
    var newCheckData = originalCheckData;
    newCheckData.state = state;
    newCheckData.lastChecked = timeOfCheck;

    // Save the update 
    _data.update('checks',newCheckData.id, newCheckData, function(err){
        if (!err) {
            // Send the new check data to the next phase in the process if needed 
            if (alertWarranted) {
                workers.alertUserToStatusChange(newCheckData);
            } else {
                console.log('Check outcome has not changed, no alert needed');
            }
        } else {
            console.log("Error trying to save updates to one of the checks");
        }
    });
 };

 // Alert the user as to a change in their check status 
 workers.alertUserToStatusChange = function(newCheckData){
     var msg = 'Alert: Your check for '+newCheckData.method.toUpperCase()+''+newCheckData.protocol+'://'+newCheckData.url+' is currently '+newCheckData.state;
     helpers.sendTwilioSms(newCheckData.userPhone, msg, function(err){
         if (!err) {
             console.log("Success: User was alerted to a status change in their check, via sms: ", msg);
         } else {
             console.log("Error: Could not send sms alert to user who had a state change ");
         }
     })
 }

 // Timer to execute the worker-process once per minute 
 workers.loop = function(){
     setInterval(function(){
         workers.gatherAllChecks();
     }, 1000 * 5)
 };

 // Init script 
 workers.init = function(){
    // Execute all the checks immediately 
    workers.gatherAllChecks();

    // Call the loop so the checks will execute later on 
    workers.loop();
 };


 // Export the module 
 module.exports = workers;
