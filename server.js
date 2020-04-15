import express from 'express';
import { json } from 'body-parser';
import JiraClient from 'jira-connector';
import morgan from 'morgan';
import passport from 'passport';
import { BasicStrategy } from 'passport-http';
import AnonymousStrategy from 'passport-anonymous';
import dateformat from 'dateformat';
import dotenv from 'dotenv';
import AsyncLock from 'async-lock';
import fs from 'fs';

/* ========================== */
/* CONSTANTS                  */
/* ========================== */

// Story size used if none is specified (note: this doesn't override a size specifically set to 0)
const DEFAULT_STORY_SIZE = 0;
const METRICS = [
  'Current 2 week velocity',
  'Rolling 2 week velocity',
  'Current 2 week average cycle time per point',
  'Rolling 2 week average cycle time per point',
  'Release Progress',
  'Acceptance Criteria conformance',
  'New tickets started in the last week',
  'Tickets finished in the last week',
  'High visibility tickets',
  'Initiative Release Projection',
  'Release Projection',
  'Release Epics',
  'Defect raise rate'
];
const STATUSES = [
  'Backlog',
  'Prioritised',
  'Test Analysis',
  'Design',
  'Dev',
  'In Review',
  'Dev Review',
  'Test Review',
  'Staging Review',
  'Business Acceptance',
  'Deploy Queue',
  'Deploy',
  'Deployed',
  'Done',
  'Not Doing'
];
const CANCELLED_STATUSES = [
  'Not Doing'
];

/* ========================== */
/* GLOBALS                    */
/* ========================== */

/* The HTTP Server */
dotenv.config();
const gApp = express();

/* The Jira client and related variables */
const gJira = new JiraClient({
  host: process.env.JIRA_HOST,
  basic_auth: {
    username: process.env.JIRA_USERNAME,
    password: process.env.JIRA_PASSWORD
  }
});
let gAuthenticationStrategy = null;

/* The data caches and related control variables */
let gCacheManagementLock = new AsyncLock();

// Cache store
let gCaches = {
  fullIssueArrayCache: [],  // The full and updated array of issues we care about
  fullIssueArrayCacheLastUpdateTime: null, // The last time the issue array cache was updated
  fullEventLogCache: [], // The full event log calculated from the full issue array
  fullEventLogCacheLastUpdateTime: null // The last time the event log cache was updated
};

let gVelocityCache = []; // The cache of velocities ([[velocity, Math.floor(Date)]]) - measured in points per 14 calendar days
let gVelocityCacheWindow = null; // The window information that applies to the velocities cache
let gVelocityCacheFutureStatuses = null; // The future statuses for the cached velocities
let gVelocityCacheProjectKey = null; // The project key for which the velocity cache was calculated

let gCycleTimeCache = {}; // The cache of cycle times - measured in days per point; projectKey => {cycleTimes: [[cycletime, Math.floor(Date)]], fromStatuses: [string], futureStatuses: [string], lastUpdateTime: Date}

let gReleaseScopeAndBurnupDataCache = {}; // id => {scopeData: [[scope, Math.floor(Date)]], burnupData: [[scope, Math.floor(Date)]], lastUpdateTime: Date}
let gInitiativeScopeAndBurnupDataCache = {}; // id => {scopeData: [[scope, Math.floor(Date)]], burnupData: [[scope, Math.floor(Date)]], lastUpdateTime: Date}

/* ========================== */
/* INITIALISATION             */
/* ========================== */

function init() {

  // Setup an authentication strategy
  if (process.env.HTTP_USER) {
    passport.use(new BasicStrategy(
      function (username, password, done) {

        if (process.env.HTTP_USER == username &&
          process.env.HTTP_PASS == password) {
          return done(null, true)
        }

        return done(null, false)
      }
    ));

    gAuthenticationStrategy = 'basic'
  } else {
    // Default ot allowing anonymous access
    passport.use(new AnonymousStrategy())
    gAuthenticationStrategy = 'anonymous'
  }

  // Set up logging etc.
  gApp.use(json());
  gApp.use(morgan('combined')); // We want to log all HTTP requests
  gApp.use(passport.initialize());

  // Set up JSON Date parser so that we read dates back in as Dates rather than Strings
  // See: https://weblog.west-wind.com/posts/2014/jan/06/javascript-json-date-parsing-and-real-dates
  var reISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*))(?:Z|(\+|-)([\d|:]*))?$/;
  var reMsAjax = /^\/Date\((d|-|.*)\)[\/|\\]$/;

  JSON.dateParser = function (key, value) {
    if (typeof value === 'string') {
        var a = reISO.exec(value);
        if (a)
            return new Date(value);
        a = reMsAjax.exec(value);
        if (a) {
            var b = a[1].split(/[-+,.]/);
            return new Date(b[0] ? +b[0] : 0 - +b[1]);
        }
    }
    return value;
  };  

  // Read the caches in from disk (So we don't go back to JIRA for the entire history of everything. again.)
  readCacheFromDisk("fullIssueArrayCache");
  readCacheFromDisk("fullIssueArrayCacheLastUpdateTime");

  readCacheFromDisk("fullEventLogCache");
  readCacheFromDisk("fullEventLogCacheLastUpdateTime");

}

// Initialise everything
init();

/* ========================== */
/* CACHE MANAGEMENT           */
/* ========================== */

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 * @param {*} extraIssues 
 * @param {*} startAt 
 */
function getFullIssueArrayCacheUpdatePromise(requestId, window, extraIssues = [], startAt = 0) {
  return gCacheManagementLock.acquire("fullIssueArrayCache", () => {
    return unsafeGetFullIssueArrayCacheUpdatePromise(requestId, window, extraIssues, startAt);
  }).then( (result) => {
    // lock released
    return result;
  });
}

function unsafeGetFullIssueArrayCacheUpdatePromise(requestId, window, extraIssues = [], startAt = 0) {
  let outOfDate = true;
  if (gCaches.fullIssueArrayCacheLastUpdateTime != null) {
    outOfDate = window.to > window.now ? window.now > gCaches.fullIssueArrayCacheLastUpdateTime : window.to > gCaches.fullIssueArrayCacheLastUpdateTime;
  }

  if (outOfDate) {

    // Get all issues that have reached the target state or later
    var lastUpdateDateTimeJQLString;
    let jql = 'issuetype in (Initiative, Epic, Story, Bug)';
    if (gCaches.fullIssueArrayCacheLastUpdateTime != null) {
      // We've done this before so make sure we only get new information
      lastUpdateDateTimeJQLString = dateformat(gCaches.fullIssueArrayCacheLastUpdateTime, 'yyyy-mm-dd HH:MM');
      jql = jql + ' AND updatedDate > "' + lastUpdateDateTimeJQLString + '"';
    }

    return gJira.search.search({ jql: jql, startAt: startAt, expand: ["changelog"] }).then((jiraRes) => {

      let totalResults = jiraRes.total;
      let maxResults = jiraRes.maxResults;

      console.info(requestId + ": Executing getFullIssueArrayCacheUpdatePromise (maxResults=" + totalResults + ", startAt=" + startAt + ")");

      // Update any existing and add any new issues
      let newIssues = jiraRes.issues.filter((issue) => {
        let cacheIndex = binarySearchIssueIndex(gCaches.fullIssueArrayCache, issue.id);
        if (cacheIndex != -1) {
          gCaches.fullIssueArrayCache[cacheIndex] = issue;
          return false;
        } else {
          return true;
        }
      });
      if (newIssues.length > 0) {
        Array.prototype.push.apply(extraIssues, newIssues);
      }

      // If we haven't got all the results yet then keep building the array
      if (startAt + maxResults < totalResults) {
        return unsafeGetFullIssueArrayCacheUpdatePromise(requestId, window, extraIssues, startAt + maxResults);
      }

      if (extraIssues.length > 0) {
        Array.prototype.push.apply(gCaches.fullIssueArrayCache, extraIssues);
        // Sort by ID number so we can index easily (and so binary search works!)
        gCaches.fullIssueArrayCache.sort((a, b) => {
          return a.id - b.id;
        });
      }
      // Update the cache last update time
      gCaches.fullIssueArrayCacheLastUpdateTime = window.now;

      // Write the updated cache to disk
      writeCacheToDisk("fullIssueArrayCache");
      writeCacheToDisk("fullIssueArrayCacheLastUpdateTime");
      
      return gCaches.fullIssueArrayCache;
    });
  } else {
    return Promise.resolve(gCaches.fullIssueArrayCache)
  }
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 */
function getFullEventLogCacheUpdatePromise(requestId, window) {
  return gCacheManagementLock.acquire("fullEventLogCache", () => {
    return unsafeGetFullEventLogCacheUpdatePromise(requestId, window);
  }).then( (result) => {
    // lock released
    return result;
  });
}

function unsafeGetFullEventLogCacheUpdatePromise(requestId, window) {

  let outOfDate = true;
  if (gCaches.fullEventLogCacheLastUpdateTime != null) {
    outOfDate = window.to > window.now ? window.now > gCaches.fullEventLogCacheLastUpdateTime : window.to > gCaches.fullEventLogCacheLastUpdateTime;
  }

  if (outOfDate) {
    return getFullIssueArrayCacheUpdatePromise(requestId, window).then( (fullIssuesArray) => {

      console.info(requestId + ": Executing getFullEventLogCacheUpdatePromise");
      gCaches.fullEventLogCache = calculateFullEventLog(fullIssuesArray);
      gCaches.fullEventLogCacheLastUpdateTime = gCaches.fullIssueArrayCacheLastUpdateTime;

      
      // Write updated cache to disk
      writeCacheToDisk("fullEventLogCache");
      writeCacheToDisk("fullEventLogCacheLastUpdateTime");

      return gCaches.fullEventLogCache;
    });
  } else {
    return Promise.resolve(gCaches.fullEventLogCache);
  }
}

function getVelocityCacheUpdatePromise(requestId, window, futureStatuses, projectKey) {
  return gCacheManagementLock.acquire("velocityCache", () => {
    return unsafeGetVelocityCacheUpdatePromise(requestId, window, futureStatuses, projectKey);
  }).then( (result) => {
    // lock released
    return result;
  });
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {*} futureStatuses 
 * @param {*} projectKey 
 */
function unsafeGetVelocityCacheUpdatePromise(requestId, window, futureStatuses, projectKey) {

  if (gVelocityCacheWindow == null || window.to > gVelocityCacheWindow.to || window.intervalMs != gVelocityCacheWindow.intervalMs || futureStatuses != gVelocityCacheFutureStatuses || gVelocityCacheProjectKey != projectKey) {
    return getFullIssueArrayCacheUpdatePromise(requestId, window).then((fullIssuesArray) => {

      console.info(requestId + ": Executing getVelocityCacheUpdatePromise (projectKey=" + projectKey + ")");

      // Filter out Epics and Initiatives
      let filteredIssueArray = fullIssuesArray.filter((issue) => {
        return issue.fields.issuetype.name != "Initiative" && issue.fields.issuetype.name != "Epic";
      });
      // If we're only interested in a specific project (which is likely) then filter it down further
      if (projectKey != null) {
        filteredIssueArray = filteredIssueArray.filter((issue) => {
          return issue.fields.project.key == projectKey;
        });
      }

      // Determine the datetime at which each issue was completed
      let completionEventsMap = getCompletionEvents(getStatusChangesByIssueKeyMap(filteredIssueArray), futureStatuses);
      // Sort the map by time
      let sortedCompletionEvents = completionEventsMap.sort((a, b) => { return a.completionTransitionDateTime - b.completionTransitionDateTime });

      // loop through the result, calculating rolling velocity for each issue
      let velocities = [];
      let completedIssueIndex = 0;
      let calcEndDatetime = window.to.getTime() > window.now.getTime() ? window.now : window.to;
      for (let curDateTime = new Date(window.from); curDateTime <= calcEndDatetime; curDateTime.setTime(curDateTime.getTime() + window.intervalMs)) {

        let twoweeksago = new Date(curDateTime).setDate(curDateTime.getDate() - 14);

        for (; completedIssueIndex <= sortedCompletionEvents.length; completedIssueIndex++) {
          let calculateVelocity = false;
          if (completedIssueIndex == sortedCompletionEvents.length) {
            // The current date exceeds the end of the completed issues
            calculateVelocity = true;
          } else {
            const completedIssue = sortedCompletionEvents[completedIssueIndex];
            const dateTime = completedIssue.completionTransitionDateTime;
            if (dateTime > curDateTime) calculateVelocity = true;
          }

          let velocity = 0;
          if (calculateVelocity) {
            for (let issueIndex = completedIssueIndex - 1; issueIndex >= 0; issueIndex--) {
              const priorCompletionEvent = sortedCompletionEvents[issueIndex];
              // If it's more than 2 weeks ago, then it doesn't count in the velocity and everything else in the array is older so break out
              if (priorCompletionEvent.completionTransitionDateTime < twoweeksago) break;
    
              let deltaV = getIssueSize(priorCompletionEvent.issue); 
              if (priorCompletionEvent.transitionType == "regression") {
                // If it's a regression then we subtract it from the velocity
                deltaV = deltaV * -1;
              }
              velocity += deltaV;
            }
            velocities.push([velocity, Math.floor(curDateTime)]);
            break;
          }
        }
      }

      // Update the cache so we can quickly retrieve the current velocity
      gVelocityCacheWindow = window;
      gVelocityCacheFutureStatuses = futureStatuses;
      gVelocityCache = velocities;
      gVelocityCacheProjectKey = projectKey;

    });
  } else {
    return Promise.resolve();
  }
}

function getDefectRaiseRateCacheUpdatePromise(requestId, window, futureStatuses, projectKey) {
  return gCacheManagementLock.acquire("defectRaiseRateCache", () => {
    return unsafeGetDefectRaiseRateCacheUpdatePromise(requestId, window, futureStatuses, projectKey);
  }).then( (result) => {
    // lock released
    return result;
  });
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {*} futureStatuses 
 * @param {*} projectKey 
 */
function unsafeGetDefectRaiseRateCacheUpdatePromise(requestId, window, futureStatuses, projectKey) {
  // TODO
  // if (gVelocityCacheWindow == null || window.to > gVelocityCacheWindow.to || window.intervalMs != gVelocityCacheWindow.intervalMs || futureStatuses != gVelocityCacheFutureStatuses || gVelocityCacheProjectKey != projectKey) {
  //   return getFullIssueArrayCacheUpdatePromise(requestId, window).then((fullIssuesArray) => {

  //     console.info(requestId + ": Executing getVelocityCacheUpdatePromise (projectKey=" + projectKey + ")");

  //     // Filter out Epics and Initiatives
  //     let filteredIssueArray = fullIssuesArray.filter((issue) => {
  //       return issue.fields.issuetype.name != "Initiative" && issue.fields.issuetype.name != "Epic";
  //     });
  //     // If we're only interested in a specific project (which is likely) then filter it down further
  //     if (projectKey != null) {
  //       filteredIssueArray = filteredIssueArray.filter((issue) => {
  //         return issue.fields.project.key == projectKey;
  //       });
  //     }

  //     // Determine the datetime at which each issue was completed
  //     let completionEventsMap = getCompletionEvents(getStatusChangesByIssueKeyMap(filteredIssueArray), futureStatuses);
  //     // Sort the map by time
  //     let sortedCompletionEvents = completionEventsMap.sort((a, b) => { return a.completionTransitionDateTime - b.completionTransitionDateTime });

  //     // loop through the result, calculating rolling velocity for each issue
  //     let velocities = [];
  //     let completedIssueIndex = 0;
  //     let calcEndDatetime = window.to.getTime() > window.now.getTime() ? window.now : window.to;
  //     for (let curDateTime = new Date(window.from); curDateTime <= calcEndDatetime; curDateTime.setTime(curDateTime.getTime() + window.intervalMs)) {

  //       let twoweeksago = new Date(curDateTime).setDate(curDateTime.getDate() - 14);

  //       for (; completedIssueIndex <= sortedCompletionEvents.length; completedIssueIndex++) {
  //         let calculateVelocity = false;
  //         if (completedIssueIndex == sortedCompletionEvents.length) {
  //           // The current date exceeds the end of the completed issues
  //           calculateVelocity = true;
  //         } else {
  //           const completedIssue = sortedCompletionEvents[completedIssueIndex];
  //           const dateTime = completedIssue.completionTransitionDateTime;
  //           if (dateTime > curDateTime) calculateVelocity = true;
  //         }

  //         let velocity = 0;
  //         if (calculateVelocity) {
  //           for (let issueIndex = completedIssueIndex - 1; issueIndex >= 0; issueIndex--) {
  //             const priorCompletionEvent = sortedCompletionEvents[issueIndex];
  //             // If it's more than 2 weeks ago, then it doesn't count in the velocity and everything else in the array is older so break out
  //             if (priorCompletionEvent.completionTransitionDateTime < twoweeksago) break;
    
  //             let deltaV = getIssueSize(priorCompletionEvent.issue); 
  //             if (priorCompletionEvent.transitionType == "regression") {
  //               // If it's a regression then we subtract it from the velocity
  //               deltaV = deltaV * -1;
  //             }
  //             velocity += deltaV;
  //           }
  //           velocities.push([velocity, Math.floor(curDateTime)]);
  //           break;
  //         }
  //       }
  //     }

  //     // Update the cache so we can quickly retrieve the current velocity
  //     gVelocityCacheWindow = window;
  //     gVelocityCacheFutureStatuses = futureStatuses;
  //     gVelocityCache = velocities;
  //     gVelocityCacheProjectKey = projectKey;

  //   });
  // } else {
  //   return Promise.resolve();
  // }
}

function getCycleTimeCacheUpdatePromise(requestId, window, fromStatuses, futureStatuses, projectKey) {
  return gCacheManagementLock.acquire("cycleTimeCache", () => {
    return unsafeGetCycleTimeCacheUpdatePromise(requestId, window, fromStatuses, futureStatuses, projectKey);
  }).then( (result) => {
    // lock released
    return result;
  });
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {*} fromStatuses 
 * @param {*} futureStatuses 
 * @param {*} projectKey 
 */
function unsafeGetCycleTimeCacheUpdatePromise(requestId, window, fromStatuses, futureStatuses, projectKey) {

  let cache = gCycleTimeCache[projectKey];
  let outOfDate = true;
  if (cache != null) {
    // Check time window
    outOfDate = window.to > window.now ? window.now > cache.lastUpdateTime : window.to > cache.lastUpdateTime;
    // Check start status
    outOfDate = outOfDate || (cache.fromStatuses != fromStatuses);
    // Check end status
    outOfDate = outOfDate || (cache.futureStatuses != futureStatuses);
  }
  if (cache == null || outOfDate) {

    return getFullIssueArrayCacheUpdatePromise(requestId, window).then((fullIssuesArray) => {

      // Filter out Epics and Initiatives
      let filteredIssueArray = fullIssuesArray.filter((issue) => {
        return issue.fields.issuetype.name != "Initiative" && issue.fields.issuetype.name != "Epic";
      });
      // If we're only interested in a specific project (which is likely) then filter it down further
      if (projectKey != null) {
        filteredIssueArray = filteredIssueArray.filter((issue) => {
          return issue.fields.project.key == projectKey;
        });
      }

      // Determine the datetime at which each issue was completed
      let statusChangesByIssueKeyMap = getStatusChangesByIssueKeyMap(filteredIssueArray);
      let completionEvents = getCompletionEvents(statusChangesByIssueKeyMap, futureStatuses, true);
      // Sort the map by time
      let sortedCompletionEvents = completionEvents.sort((a, b) => { return a.completionTransitionDateTime - b.completionTransitionDateTime });

      let outputData = [];
      let calcEndDatetime = window.to.getTime() > window.now.getTime() ? window.now : window.to;
      let completedIssueIndex = 0
      for (let curDateTime = new Date(window.from); curDateTime <= calcEndDatetime; curDateTime.setTime(curDateTime.getTime() + window.intervalMs)) {

        let twoweeksago = new Date(curDateTime).setDate(curDateTime.getDate() - 14);

        // Sort the events by time and loop through the result, calculating rolling cycle time for each issue
        for (; completedIssueIndex < sortedCompletionEvents.length; completedIssueIndex++) {
          let calculateMetric = false;
          if (completedIssueIndex == sortedCompletionEvents.length) {
            // The current date exceeds the end of the completed issues
            calculateMetric = true;
          } else {
            const completedIssue = sortedCompletionEvents[completedIssueIndex];
            const dateTime = completedIssue.completionTransitionDateTime;
            if (dateTime > curDateTime) calculateMetric = true;
          }

          // TODO: LOADS of this code is the same as the velocity calc code - consolidate these
          
          // Get the list of issues completed in the 2 weeks prior to this issue
          if (calculateMetric) {
            let twoWeekCompletedIssueList = [];
            for (let issueIndex = completedIssueIndex - 1; issueIndex >= 0; issueIndex--) {
              const priorCompletionEvent = sortedCompletionEvents[issueIndex];
              // If it's more than 2 weeks ago, then it doesn't count in the velocity and everything else in the array is older so break out
              if (priorCompletionEvent.completionTransitionDateTime < twoweeksago) break;

              twoWeekCompletedIssueList.push(priorCompletionEvent.issue.key);
            }

            // Filter the map by these issues
            var filteredStatusChangeMap = Object.fromEntries(Object.entries(statusChangesByIssueKeyMap).filter(([k,v]) => {
              return twoWeekCompletedIssueList.includes(k);
            }));
            // Calculate the average cycle time for these issues
            let avgCycleTimePerPoint = calculateAverageCycleTimePerPointForIssues(filteredStatusChangeMap, fromStatuses, futureStatuses, curDateTime);

            outputData.push([avgCycleTimePerPoint, Math.floor(curDateTime)]);
            break;
          }
        }
      }

      // Update the cache
      gCycleTimeCache[projectKey] = {
        cycleTimes: outputData,
        fromStatuses: fromStatuses,
        futureStatuses: futureStatuses,
        lastUpdateTime: window.now >= window.to ? window.to : window.now
      }

    });

  } else {
    return Promise.resolve();
  }
}

function getScopeAndBurnupCacheUpdatePromise(requestId, window, targetId, isRelease) {
  return gCacheManagementLock.acquire("scopeAndBurnupCache", () => {
    return unsafeGetScopeAndBurnupCacheUpdatePromise(requestId, window, targetId, isRelease);
  }).then( (result) => {
    // lock released
    return result;
  });
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 * @param {*} targetId 
 * @param {*} isRelease 
 */
function unsafeGetScopeAndBurnupCacheUpdatePromise(requestId, window, targetId, isRelease) {
  let scopeAndBurnupDataCache = isRelease ? gReleaseScopeAndBurnupDataCache[targetId] : gInitiativeScopeAndBurnupDataCache[targetId];
  let outOfDate = true;
  if (scopeAndBurnupDataCache != null) {
    outOfDate = window.to > window.now ? window.now > scopeAndBurnupDataCache.lastUpdateTime : window.to > scopeAndBurnupDataCache.lastUpdateTime;
  }
  if (scopeAndBurnupDataCache == null || outOfDate) {
    return getFullEventLogCacheUpdatePromise(requestId, window).then( (eventLog) => {

      console.info(requestId + ": Executing getScopeAndBurnupCacheUpdatePromise (targetId=" + targetId + ", eventLogLength=" + eventLog.length + ")");
      calculateScopeAndBurnupTimeseries(window, eventLog, targetId, isRelease);
    });

  } else {
    return Promise.resolve();
  }
}

function writeCacheToDisk(cacheName) {
  var jsonContent = JSON.stringify(gCaches[cacheName]);

  // Make the caches directory if it doesn't exist already
  if (!fs.existsSync('./caches')){
    fs.mkdirSync('./caches');
  }
  try {
    fs.writeFileSync('caches/' + cacheName + '.json', jsonContent, 'utf8');
  } catch (err) {
    console.error("Error occurred writing cache to disk: " + cacheName);
    console.error(err);
  }

}

function readCacheFromDisk(cacheName) {
  console.info('Reading in cache ' + cacheName);
  try {
    var jsonData = fs.readFileSync('caches/' + cacheName + '.json');
    // Set the global variable holding the cache directly
    gCaches[cacheName] = JSON.parse(jsonData, JSON.dateParser);
  } catch (err) {
    if (err.code != 'ENOENT') {
      console.error("Error reading cache from disk: " + cacheName);
      console.error(err);
    }
  }
}

/* ========================== */
/* PROMISES                   */
/* ========================== */

/**
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {{target: string, refId: string, type: string, data: {}}} target The request target object
 * @param {*} result The result
 */
function getPromisesForMetric(requestId, window, target, result) {
  switch (target.target) {
    case METRICS[0]: return getCurrent2WeekVelocityPromise(requestId, window, target, result);
    case METRICS[1]: return getRolling2WeekVelocityPromise(requestId, window, target, result);
    case METRICS[2]: return getCurrent2WeekAverageCycleTimePerPointPromise(requestId, window, target, result);
    case METRICS[3]: return getRolling2WeekAverageCycleTimePerPointPromise(requestId, window, target, result);
    case METRICS[4]: return getReleaseProgressPromises(requestId, window, target, result);
    case METRICS[5]: return getAcceptanceCriteriaConformancePromise(requestId, target, result);
    case METRICS[6]: return getNewTicketsStartedLastWeekPromise(requestId, target, result);
    case METRICS[7]: return getTicketsFinishedLastWeekPromise(requestId, target, result);
    case METRICS[8]: return getHighVizTicketsPromise(requestId, target, result);
    case METRICS[9]: return getInitiativeProjectionPromise(requestId, window, target, result);
    case METRICS[10]: return getReleaseProjectionPromise(requestId, window, target, result);
    case METRICS[11]: return getReleaseEpicsPromise(requestId, window, target, result);
    case METRICS[12]: return getDefectRaiseRatePromise(requestId, window, target, result);
  }
}

/**
 * Calculates a release scope, burnup and projection dataset for an initiative
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The range the data should be returned within
 * @param {{target: string, refId: string, type: string, data: {}}} target The request target object
 * @param {{target: string, datapoints: [[]]}[]} result 
 * @return {Promise}
 */
function getReleaseProjectionPromise(requestId, window, target, result) {

  // Get the initiative we're projecting
  let releaseId = getReleaseId(target);

  return getScopeAndBurnupCacheUpdatePromise(requestId, window, releaseId, true).then(() => {

    console.info(requestId + ": Executing getReleaseProjectionPromise (releaseId=" + releaseId + ")");
    let burnupCache = gReleaseScopeAndBurnupDataCache[releaseId];

    // Calculate scope and burnup series
    let scopeData = burnupCache.scopeData.filter(value => {return value[1] >= Math.floor(window.from)});
    result.push({
      target: "Scope",
      datapoints: scopeData
    });
    padStartToWindow(scopeData, window);
    let burnupData = burnupCache.burnupData.filter(value => {return value[1] >= Math.floor(window.from)});
    result.push({
      target: "Burnup",
      datapoints: burnupData
    });
    padStartToWindow(burnupData, window);
    
    // Only add projections if we need to
    if (window.to > window.now) {
      return getBurnupProjectionFromCachePromise(requestId, window, target, scopeData, burnupData, result);
    } else {
      return result;
    }
  
  });

}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 * @param {*} target 
 */
function getDetermineVelocityLimitsPromise(requestId, window, target) {

  let vSource = getVelocitySource(target);
  switch (vSource) {
    // TODO: Add Percentile at a later date
    case "Explicit":
      return Promise.resolve(getVelocityBounds(target));
    case "Limits":
    default:
      return getVelocityBoundsFromHistoricDataPromise(requestId, window, target);
  }

}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 * @param {*} target 
 * @return {{max: number, cur: number, min: number}} a object containing the bounds of the velocity
 */
function getVelocityBoundsFromHistoricDataPromise(requestId, window, target) {
  let completionStatuses = getFutureStatusesFromStartingStatus(getToStatus(target), true);
  let projectKey = getProjectKey(target);
  return getVelocityCacheUpdatePromise(requestId, window, completionStatuses, projectKey).then(() => {

    console.info(requestId + ": Executing getVelocityBoundsFromHistoricDataPromise (projectKey=" + projectKey + ")");

    // Calculate current, best and worst case velocities (assume 2 week rolling average)
    // Make sure we're restricting velocity choices to the displayed window
    let velocities = gVelocityCache.filter(value => {return value[1] >= Math.floor(window.from)});
    let minV = velocities[0][0];
    let maxV = velocities[0][0];
    let curV = velocities[velocities.length-1][0];
    velocities.forEach(velocityPoint => {
      let curV = velocityPoint[0];
      minV = Math.min(curV, minV);
      maxV = Math.max(curV, maxV);
    });

    return {
      max: maxV,
      cur: curV,
      min: minV
    }
  });
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 * @param {*} target 
 * @param {*} scopeData 
 * @param {*} burnupData 
 * @param {*} result 
 * @return {PromiseLike|{target: string, datapoints: [number, number][]}[]} Eventually this returns "result" populated with more data. It may return a Promise to do so if additional async calls to JIRA need to be made.
 */
function getBurnupProjectionFromCachePromise(requestId, window, target, scopeData, burnupData, result) {

  return getDetermineVelocityLimitsPromise(requestId, window, target).then((vBounds) => {

    console.info(requestId + ": Executing getBurnupProjectionFromCachePromise");

    // Work out what the burnup projection would be at the end of the range
    let timeDiffFortnights = (window.to.getTime() - window.now.getTime())/(1000*60*60*24*14);
    let scopeNow = scopeData[scopeData.length-1][0];
    let doneScopeNow = burnupData[burnupData.length-1][0];
    let maxVScope = doneScopeNow + timeDiffFortnights * vBounds.max;
    let curVScope = doneScopeNow + timeDiffFortnights * vBounds.cur;
    let minVScope = doneScopeNow + timeDiffFortnights * vBounds.min;
    result.push({
      // target: "Max V (" + vBounds.max.toFixed(0) + ") projection",
      target: "Max V projection",
      datapoints: [
        [doneScopeNow, Math.floor(window.now)],
        [maxVScope, Math.floor(window.to)]
      ]
    });
    result.push({
      // target: "Cur V (" + vBounds.cur.toFixed(0) + ") projection",
      target: "Cur V projection",
      datapoints: [
        [doneScopeNow, Math.floor(window.now)],
        [curVScope, Math.floor(window.to)]
      ]
    });
    result.push({
      // target: "Min V (" + vBounds.min.toFixed(0) + ") projection",
      target: "Min V projection",
      datapoints: [
        [doneScopeNow, Math.floor(window.now)],
        [minVScope, Math.floor(window.to)]
      ]
    });
    result.push({
      target: "Scope projection",
      datapoints: [
        [scopeNow, Math.floor(window.now)],
        [scopeNow, Math.floor(window.to)]
      ]
    });

    let highestPoint = Math.max(...scopeData.map((value) => {return value[0]}));
    highestPoint = Math.max(highestPoint, maxVScope, ...burnupData.map((value) => {return value[0]}));

    // Add the time vertical interception lines, including "now"
    addVerticalLine(window.now, "Now", highestPoint, result);
    // TODO: Other interceptors
    // Add the target release date as a vertical
    // TODO: In future, get this from JIRA using a version information request
    addVerticalLine(getTargetReleaseDate(target), "Target", highestPoint, result);

    return result;

  });
}

/**
 * Calculates a release scope, burnup and projection dataset for an initiative
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The range the data should be returned within
 * @param {{target: string, refId: string, type: string, data: {}}} target The request target object
 * @param {{target: string, datapoints: [[]]}[]} result 
 * @return {Promise}
 */
function getInitiativeProjectionPromise(requestId, window, target, result) {

  // Get the initiative we're projecting
  let initiativeId = getInitiativeId(target);
  
  return getScopeAndBurnupCacheUpdatePromise(requestId, window, initiativeId, false).then(() => {

    return addBurnupProjectionFromCache(window, target, gInitiativeScopeAndBurnupDataCache[initiativeId], result);

  }); // getScopeAndBurnupCacheUpdatePromise.then
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} target 
 * @param {*} result 
 */
function getHighVizTicketsPromise(requestId, target, result) {

  let jql = 'project = "ENG" AND labels = high-viz';

  return gJira.search.search({ jql: jql }).then((jiraRes) => {

    let tableRows = [];
    jiraRes.issues.forEach( issue => {
      tableRows.push([
        issue.key,
        issue.fields.summary,
        issue.fields.status.name + ' ' + issue.fields.customfield_10059.value
      ])
    });
    
    // Only returns a table type (not timeserie)
    return result.push({
      target: target,
      columns: [
        {text: "Key", type: "string"},
        {text: "Title", type: "string"},
        {text: "Status", type: "string"}
      ],
      rows: tableRows,
      type: "table"
    });

  });

}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} target 
 * @param {*} result 
 */
function getNewTicketsStartedLastWeekPromise(requestId, target, result) {

  let jql = ('project = "ENG" AND status changed from ("Prioritised") after -1w and status not in ("Backlog")');
  return getTicketsTableFromJQLPromise(target, result, jql);

}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} target 
 * @param {*} result 
 */
function getTicketsFinishedLastWeekPromise(requestId, target, result) {

  let jql = ('project = "ENG" AND status changed to ("Deploy Queue", Deploy, Deployed) after -1w and status in ("Deploy Queue", Deploy, Deployed)');
  return getTicketsTableFromJQLPromise(target, result, jql);

}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} target 
 * @param {*} result 
 */
function getAcceptanceCriteriaConformancePromise(requestId, target, result) {
  // customfield_10060 = acceptance critera field

  let jql = ('project = "ENG" AND labels = high-viz');

  return gJira.search.search({ jql: jql }).then((jiraRes) => {
    
    let numStories = jiraRes.issues.length;
    let numACs = 0;
    jiraRes.issues.forEach( issue => {
      if (issue.fields.customfield_10060 != null) numACs++;
    });

    // 'timeserie'
    return result.push({
      target: target,
      datapoints: [[numACs/numStories*100, Math.floor(new Date())]]
    });

  });

}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} target 
 * @param {*} result 
 * @return an array of Promises, one for each version ID
 */
function getReleaseProgressPromises(requestId, window, target, result) {
  let versionIds = getVersionIds(target);
  let p = [];
  versionIds.forEach(versionId => {
    p.push(getReleaseProgressPromise(requestId, window, result, versionId));
  });
  return p;
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 * @param {*} result 
 * @param {*} versionId 
 */
function getReleaseProgressPromise(requestId, window, result, versionId) {

  let releaseName = "";

  let p = [];
  p.push(getScopeAndBurnupCacheUpdatePromise(requestId, window, versionId, true));
  p.push(gJira.version.getVersion({versionId: versionId}).then((jiraRes) => {
    releaseName = jiraRes.name;
  }));

  // Wait for the scope and burnup caches to be updated AND for the version information to update
  return Promise.all(p).then(() => {

    let cache = gReleaseScopeAndBurnupDataCache[versionId];
    let done = cache.burnupData[cache.burnupData.length-1][0];
    let scope = cache.scopeData[cache.scopeData.length-1][0];
    
    let completePct = 0;
    if (scope != 0) {
      completePct = done / scope * 100;
    }

    return result.push({
      target: releaseName,
      datapoints: [[completePct, Math.floor(cache.lastUpdateTime)]]
    });

  });
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 * @param {*} target 
 * @param {*} result 
 */
function getCurrent2WeekAverageCycleTimePerPointPromise(requestId, window, target, result) {

  let futureStatuses = getFutureStatusesFromStartingStatus(getToStatus(target));
  let fromStatuses = getPreviousStatusesFromStartingStatus(getFromStatus(target));
  let projectKey = getProjectKey(target);

  return getCycleTimeCacheUpdatePromise(requestId, window, fromStatuses, futureStatuses, projectKey).then(() => {

    let cache = gCycleTimeCache[projectKey].cycleTimes;
    return result.push({
      target: target,
      datapoints: [cache[cache.length-1]]
    });
  });
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} target
 * @param {*} result 
 * @returns {Promise}
 */
function getRolling2WeekAverageCycleTimePerPointPromise(requestId, window, target, result) {

  let futureStatuses = getFutureStatusesFromStartingStatus(getToStatus(target));
  let fromStatuses = getPreviousStatusesFromStartingStatus(getFromStatus(target));
  let projectKey = getProjectKey(target);

  return getCycleTimeCacheUpdatePromise(requestId, window, fromStatuses, futureStatuses, projectKey).then(() => {
    let cycleTimes = gCycleTimeCache[projectKey].cycleTimes;
    // Trim the data to start at the beginning of the return window
    let filteredCycleTimes = cycleTimes.filter(value => {return value[1] >= Math.floor(window.from)});
    // If the time frame included a future projection, then add a projection point based on the last velocity calculated
    padEndToWindow(filteredCycleTimes, window);
    // Return a time series object type
    return result.push({
      target: target,
      datapoints: filteredCycleTimes
    });
  });
}

/**
 * Pads out the dataPoints array to include a first point at the beginning of the window. This will be the same as the first value.
 * 
 * @param {[number, number][]} dataPoints The data points array in the format required for Grafana
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The range the data should be returned within
 */
function padStartToWindow(dataPoints, window) {

  if (dataPoints[0][1] != Math.floor(window.from)) {
    dataPoints.unshift([dataPoints[0][0], Math.floor(window.from)])
  }

}

/**
 * Pads out the dataPoints array to include a last point at the end. This will be the same as the last value.
 * 
 * @param {[number, number][]} dataPoints The data points array in the format required for Grafana
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The range the data should be returned within
 */
function padEndToWindow(dataPoints, window) {

  if (dataPoints[dataPoints.length-1][1] != Math.floor(window.to)) {
    dataPoints.push([dataPoints[dataPoints.length-1][0], Math.floor(window.to)])
  }

}

/**
 * 
 * @param {*} target 
 * @return {string} the target status, e.g. 'Deploy Queue'
 */
function getToStatus(target) {
  // Default status is Deploy Queue
  let toStatus = STATUSES[STATUSES.length-1];
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('toStatus')) {
        toStatus = target.data.toStatus;
      }
    }
  }
  return toStatus;
}

/**
 * 
 * @param {*} target 
 * @return {string} the target status, e.g. 'Dev'
 */
function getFromStatus(target) {
  let fromStatus = STATUSES[0];
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('fromStatus')) {
        fromStatus = target.data.fromStatus;
      }
    }
  }
  return fromStatus;
}

/**
 * 
 * @param {*} target 
 * @return {string} the target project key (e.g. 'ENG')
 */
function getProjectKey(target) {
  let projectKey = null;
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('projectKey')) {
        projectKey = target.data.projectKey;
      }
    }
  }
  return projectKey;
}

/**
 * 
 * @param {*} target 
 * @return {string} The velocity source, either "Explicit" or "Limits" only at the moment
 */
function getVelocitySource(target) {
  let vSource = "Limits";
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('vSource')) {
        vSource = target.data.vSource;
      }
    }
  }
  return vSource;
}

/**
 * 
 * @param {*} target 
 * @return {{max: number, cur: number, min: number}} a object containing the bounds of the velocity
 */
function getVelocityBounds(target) {
  let vBounds = {max: 0, cur: 0, min: 0};
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('vBounds')) {
        vBounds = target.data.vBounds;
      }
    }
  }
  return vBounds;
}

/**
 * 
 * @param {*} target 
 * @return {Date} The release date
 */
function getTargetReleaseDate(target) {
  let releaseDate = new Date();
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('releaseDate')) {
        releaseDate = new Date(target.data.releaseDate);
      }
    }
  }
  return releaseDate;
}

/**
 * 
 * @param {*} target 
 * @return {string} the target initiative ID, e.g. 12345
 */
function getInitiativeId(target) {
  // Default project key is null (which means all projects)
  let initiativeId = null;
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('initiativeId')) {
        initiativeId = target.data.initiativeId;
      }
    }
  }
  return initiativeId;
}

/**
 * 
 * @param {*} target 
 * @return {string} the target release ID, e.g. 12345
 */
function getReleaseId(target) {
  // Default project key is null (which means all projects)
  let releaseId = null;
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('releaseId')) {
        releaseId = target.data.releaseId;
      }
    }
  }
  return releaseId;
}

/**
 * Get versionIDs from the "target"
 * 
 * @param {*} target 
 * @return {number} an array of target version IDs
 */
function getVersionIds(target) {
  // Default status is Deploy Queue
  let versionIds = [];
  if (target.hasOwnProperty('data')) {
    if (target.data != null) {
      if (target.data.hasOwnProperty('versionIds')) {
        versionIds = target.data.versionIds;
      }
    }
  }
  return versionIds;
}

/**
 * 
 * @param {string} toStatus The status to start from
 * @param {boolean} completionOnly if true then statuses that are considered "cancelled" are removed
 * @return {string[]} an array of statuses starting with toStatus
 */
function getFutureStatusesFromStartingStatus(toStatus, completionOnly = false) {
  // Statuses are in value stream order, so get every status after the one we want
  let futureStatuses = [toStatus];
  let gotIt = false;
  STATUSES.forEach(status => {
    if (gotIt) {
      futureStatuses.push(status);
    } else if (status == toStatus) {
      gotIt = true;
    }
  });
  if (completionOnly) {
    futureStatuses = futureStatuses.filter((value) => {
      return !CANCELLED_STATUSES.includes(value);
    });
  }
  return futureStatuses;
}

/**
 * 
 * @param {string} endStatus The status to finish on
 * @return {string[]} an ordered array of statuses starting before endStatus
 */
function getPreviousStatusesFromStartingStatus(endStatus) {
  // Statuses are in value stream order, so get every status before the one we want
  let previousStatuses = [];
  let gotIt = false;
  STATUSES.forEach(status => {
    if (!gotIt) {
      previousStatuses.push(status);
    }
    if (status == endStatus) {
      gotIt = true;
    }
  });
  return previousStatuses;
}

function getInStringFromStatusArray(statusArray) {
  let updatedArray = [];
  statusArray.forEach(status => {
    updatedArray.push('"' + status + '"');
  });
  return updatedArray.join(',');
}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {*} window 
 * @param {*} target 
 * @param {*} result 
 */
function getCurrent2WeekVelocityPromise(requestId, window, target, result) {

  let completionStatuses = getFutureStatusesFromStartingStatus(getToStatus(target), true);
  let projectKey = getProjectKey(target);

  return getVelocityCacheUpdatePromise(requestId, window, completionStatuses, projectKey).then(() => {
    return result.push({
      target: target,
      datapoints: [gVelocityCache[gVelocityCache.length-1]]
    });
  });

}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {{target: string, refId: string, type: string, data: {}}} target The request target object
 * @param {*} result The result
 */
function getRolling2WeekVelocityPromise(requestId, window, target, result) {

  let completionStatuses = getFutureStatusesFromStartingStatus(getToStatus(target), true);
  let projectKey = getProjectKey(target);

  return getVelocityCacheUpdatePromise(requestId, window, completionStatuses, projectKey).then(() => {
    // If the time frame included a future projection, then add a projection point based on the last velocity calculated
    let velocities = gVelocityCache.filter(value => {return value[1] >= Math.floor(window.from)});
    padEndToWindow(velocities, window);
    // Return a time series object type
    return result.push({
      target: target,
      datapoints: velocities
    });
  });

}

/**
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {{target: string, refId: string, type: string, data: {}}} target The request target object
 * @param {*} result The result
 */
function getDefectRaiseRatePromise(requestId, window, target, result) {

  // let projectKey = getProjectKey(target);

  // return getVelocityCacheUpdatePromise(requestId, window, futureStatuses, projectKey).then(() => {
  //   // If the time frame included a future projection, then add a projection point based on the last velocity calculated
  //   let velocities = gVelocityCache.filter(value => {return value[1] >= Math.floor(window.from)});
  //   padEndToWindow(velocities, window);
  //   // Return a time series object type
  //   return result.push({
  //     target: target,
  //     datapoints: velocities
  //   });
  // });

}

/**
 * Create a Grafana table of tickets from a JIRA JQL Query
 * 
 * @param {*} target The target object from Grafana defining the query data requirement
 * @param {*[]} result The result array object to aggregate results to
 * @param {string} jql The JQL QUery string that gets the tickets required in the table
 * @return {Promise} The Promise that will return the table
 */
function getTicketsTableFromJQLPromise(target, result, jql) {

  return gJira.search.search({ jql: jql }).then((jiraRes) => {

    let tableRows = [];
    jiraRes.issues.forEach(issue => {
      // customfield_10008 = Epic Link
      tableRows.push([issue.key, issue.fields.summary, issue.fields.customfield_10008]);
    });

    // Only returns a table type (not timeserie)
    return result.push({
      target: target,
      columns: [
        {text: "Key", type: "string"},
        {text: "Title", type: "string"},
        {text: "Epic Key", type: "string"}
      ],
      rows: tableRows,
      type: "table"
    });

  });

}

/**
 * Performs a binary search on the provided sorted list and returns the index of the item if found. If it can't be found it'll return -1.
 * Note: Taken from https://github.com/Olical/binary-search/blob/master/src/binarySearch.js
 * 
 * @param {*[]} issueList Items to search through.
 * @param {*} item The item to look for.
 * @param exactOnly if false, then this will return index of the closest item if the item isn't found, rather than -1
 * @return {Number} The index of the item if found, -1 if not.
 */
function binarySearchIssueIndex(issueList, id, exactOnly = true) {
  var min = 0;
  var max = issueList.length - 1;
  var guess;

  var bitwise = (max <= 2147483647) ? true : false;
  if (bitwise) {
    while (min <= max) {
      guess = (min + max) >> 1;
      if (issueList[guess].id === id) { return guess; }
      else {
        if (issueList[guess].id < id) { min = guess + 1; }
        else { max = guess - 1; }
      }
    }
  } else {
    while (min <= max) {
      guess = Math.floor((min + max) / 2);
      if (issueList[guess].id === id) { return guess; }
      else {
        if (issueList[guess].id < id) { min = guess + 1; }
        else { max = guess - 1; }
      }
    }
  }
  return exactOnly ? -1 : guess;
}

/**
 * Retrieves the list of Epics that are in or have children in the specified release.
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {{target: string, refId: string, type: string, data: {}}} target The request target object
 * @param {*} result The result
 * @param {string} epicKeys The keys of the Epics we want to include (gets populated by the early runs of this method)
 * @param {number} startAt The result number to start at (for handling paginated responses)
 */
function getReleaseEpicsPromise(requestId, window, target, result, epicKeys = [], startAt = 0) {

  let versionIDs = getVersionIds(target);
  if (versionIDs.length == 0) return Promise.resolve(result);

  let jql = 'fixVersion IN (' + versionIDs.join(',') + ') AND issuetype IN (Story, Bug)';

  return gJira.search.search({ jql: jql, startAt: startAt}).then((jiraRes) => {

    let totalResults = jiraRes.total;
    let maxResults = jiraRes.maxResults;

    console.info(requestId + ": Executing getReleaseEpicsPromise (maxResults=" + totalResults + ", startAt=" + startAt + ")");

    jiraRes.issues.forEach((issue) => {
      if (issue.fields.issuetype.name == "Epic") {
        epicKeys.push(issue.key);
      } else if (issue.fields.issuetype.name == "Story") {
        if (issue.fields.customfield_10008) {
          epicKeys.push(issue.fields.customfield_10008);
        }
      }
    });

    // If we haven't got all the results yet then keep building the array
    if (startAt + maxResults < totalResults) {
      return getReleaseEpicsPromise(requestId, window, target, result, epicKeys, startAt + maxResults);
    }

    // Got all the Epic Keys, now we need to get their details
    return populateReleaseEpics(requestId, window, target, result, epicKeys);
  });
}

function populateReleaseEpics(requestId, window, target, result, epicKeys, tableRows = [], startAt = 0) {

  let jql = 'key IN (' + epicKeys.join(',') + ')';

  return gJira.search.search({jql: jql, startAt: startAt}).then((jiraRes) => {

    let totalResults = jiraRes.total;
    let maxResults = jiraRes.maxResults;

    console.info(requestId + ": Executing populateReleaseEpics (maxResults=" + totalResults + ", startAt=" + startAt + ")");

    jiraRes.issues.forEach(issue => {
      tableRows.push([
        issue.key,
        issue.fields.summary
      ])
    });
    
    // If we haven't got all the results yet then keep building the array
    if (startAt + maxResults < totalResults) {
      return populateReleaseEpics(requestId, window, target, result, epicKeys, tableRows, startAt + maxResults);
    }

    // Only returns a table type (not timeseries)
    return result.push({
      target: target,
      columns: [
        {text: "Key", type: "string"},
        {text: "Title", type: "string"}
      ],
      rows: tableRows,
      type: "table"
    });

  });

}

/* ========================== */
/* CALCS / UTILITIES          */
/* ========================== */

function addVerticalLine(datetime, targetName, maxVerticalPoint, result) {
  result.push({
    target: targetName,
    datapoints: [
      [0, Math.floor(datetime)],
      [maxVerticalPoint, Math.floor(datetime)]
    ]
  });
}

/**
 * 
 * @param {*} issue A JIRA Issue object
 * @param {string} idType Either "key" or "id"
 */
function getParentIdentifier(issue, idType) {
  if (issue.fields.issuetype.name == "Epic") {
    // Parent Link
    if (issue.fields.customfield_10009.hasOwnProperty('data')) {
      if (idType == "key") {
        return issue.fields.customfield_10009.data.key;
      } else return issue.fields.customfield_10009.data.id;
    } else return null;
  } else if (issue.fields.issuetype.name == "Initative") {
    // No parent possible
    return null;
  } else {
    // Epic Link
    if (idType == "key") return issue.fields.customfield_10008;
    else return null;
  }
}

function calculateVersionSize(versionIssueMap, versionId) {
  let totalSize = 0;
  let versionIssues = versionIssueMap[versionId];
  if (versionIssues != null) {
    versionIssueMap[versionId].forEach(i => {
      totalSize += i.size;
    });
  }
  return totalSize;
}

/**
 * 
 * @param {*[]} issues A JIRA issues array
 * @return {{datetime: Date, issueId: number, event: string, eventDetails: {issueKey: string, size: number, type: string, parentKey: string, parentId: number, resolution: string, childId: number, versionId: number, versions: number[]}}[]} a time ordered log of events
 */
function calculateFullEventLog(issues) {
  let eventLog = [];

  // Create the event log
  issues.forEach( issue => {

    // Note: issues can change keys but not IDs.
    /* There is no event that shows what was defined on issue creation so we have to assume it's what's set currently and then change reprospectively if required based on change events */
    let createdEvent = {
      datetime: new Date(issue.fields.created),
      issueId: issue.id,
      event: "created",
      eventDetails: {
        issueKey: issue.key,
        size: getIssueSize(issue),
        type: issue.fields.issuetype.name,
        parentKey: getParentIdentifier(issue, "key"),
        parentId: getParentIdentifier(issue, "id"),
        resolution: null,
        versions: issue.fields.fixVersions.map(version => {return version.id})
      }
    }

    let parentChange = false;
    let sizeChange = false;
    let doneCreationReverseForVersions = {};

    // Loop through all the events in this issue's history in order of event occurance (determined by ID number)
    issue.changelog.histories.sort( (a, b) => {return a.id - b.id}).forEach(change => {
      change.items.forEach( changeItem => {
        if (changeItem.fieldId == "customfield_10009" || changeItem.fieldId == "customfield_10008") {
          // customfield_10009 = Parent initiative
          // customfield_10008 = Epic Link

          // In the change log, the value is only referred to by the issue ID
          // Record that we've changed the parent at some point in the history and fix the history
          // These are in datetime order, so the first change is the change from creation

          if (!parentChange) {
            let oldId = null;
            let oldKey = null;
            if (changeItem.fieldId == "customfield_10008") {
              oldId = changeItem.from;
              oldKey = changeItem.fromString;
            } else {
              oldId = changeItem.fromString;
              oldKey = null;
            }

            createdEvent.eventDetails.parentID = oldId;
            createdEvent.eventDetails.parentKey = oldKey;
            parentChange = true;
          }

          let newId = null;
          let newKey = null;
          if (changeItem.fieldId == "customfield_10008") {
            newId = changeItem.to;
            newKey = changeItem.toString;
          } else {
            newId = changeItem.toString;
            newKey = null;
          }

          // Create the event
          eventLog.push({
            datetime: new Date(change.created),
            issueId: issue.id,
            event: "parentChange",
            eventDetails: {
              parentId: newId,
              parentKey: newKey,
            }
          });

        } else if (changeItem.fieldId == "customfield_10016") {
          // customfield_10016 = Story Points
          // fromString / toString contain story point values, to/from are null
          // Only applies to stories

          // Fix history
          if (!sizeChange) {
            createdEvent.eventDetails.size = (changeItem.fromString == null ? null : parseInt(changeItem.fromString));
            sizeChange = true;
          }

          eventLog.push({
            datetime: new Date(change.created),
            issueId: issue.id,
            event: "sizeChange",
            eventDetails: {
              size: (changeItem.toString == null || changeItem.toString == "" ? null : parseInt(changeItem.toString))
            }
          });
        } else if (changeItem.field == "Epic Child") {
          // Only applies to Epics

          // Create the event
          eventLog.push({
            datetime: new Date(change.created),
            issueId: issue.id,
            event: (changeItem.from == null ? "addChild" : "removeChild"),
            eventDetails: {
              childId: (changeItem.from == null ? changeItem.to : changeItem.from)
            }
          });

        } else if (changeItem.fieldId == "fixVersions") {

          let versionId = (changeItem.from == null ? changeItem.to : changeItem.from);
          // Create the event
          eventLog.push({
            datetime: new Date(change.created),
            issueId: issue.id,
            event: (changeItem.from == null ? "addVersion" : "removeVersion"),
            eventDetails: {
              versionId: versionId
            }
          });

          // Reverse engineer the create event
          // If we've had an add on a version that was already on the create event, then lets assume that it wasn't there to start off with - this will sometimes be wrong but there's nothing we can do about that.
          if (!doneCreationReverseForVersions.hasOwnProperty(versionId)) {
            if (changeItem.from == null) {
              let versionIndex = createdEvent.eventDetails.versions.findIndex(vId => {return vId == versionId});
              if (versionIndex != -1) {
                // Remove that version from the list of versions that this ticket started with
                createdEvent.eventDetails.versions.splice(versionIndex, 1);
              }
            } else {
              let versionIndex = createdEvent.eventDetails.versions.findIndex(vId => {return vId == versionId});
              if (versionIndex == -1) {
                // Add that version to the list of versions that this ticket started with
                createdEvent.eventDetails.versions.push(versionId);
              }
            }
            doneCreationReverseForVersions[versionId] = true;
          }

        } else if (changeItem.fieldId == "resolution") {
          eventLog.push({
            datetime: new Date(change.created),
            issueId: issue.id,
            event: "resolutionChange",
            eventDetails: {
              resolution: changeItem.toString
            }
          })
        }
      });
    });
    
    // Add the creation event to the log
    eventLog.push(createdEvent);

//    console.debug("Processed events for issue " + issue.key);
  });

  // Sort the event log by event datetime in ascending order
  eventLog.sort( (a,b) => a.datetime - b.datetime);

  return eventLog;
}

/**
 * 
 * @param {Object.<number, {id: number, key: string, type: string, size: number, parentId: number, parentKey: string, children: *[]}>} issues dictionary of issueId against issue
 * @param {Object.<string, number>} keyToIdMap Map of keys to Ids 
 * @param {{id: number, key: string, type: string, size: number, parentId: number, parentKey: string, children: *[], versions: number[]}} issue 
 * @param {number} issueId 
 * @returns true if issue is a descendent of issueId
 */
function isChildOf(issues, keyToIdMap, issue, parentIssueId) {
  let parentId = issue.parentId;
  if (parentId == null) {
    if (issue.parentKey != null) {
      parentId = keyToIdMap[issue.parentKey];
    }
  }
  if (parentId == parentIssueId) {
    return true;
  } else {
    if (parentId != null) {
      let directParentIssue = issues[parentId];
      // It's possible that we don't have a record of the parent if it's been permanently deleted
      if (directParentIssue != null) {
        return isChildOf(issues, keyToIdMap, directParentIssue, parentIssueId);
      } else {
        return false;
      }
    } else {
      return false;
    }
  }
}

/**
 * Calculates the total size of an issue including all of its children
 * @param {{id: number, key: string, type: string, size: number, parentId: number, parentKey: string, children: *[], versions: number[]}} issue The issue to calculate the size of
 * @param {boolean} onlyResolved If true, then only include points if it's resolved, otherwise everything counts
 * @return {number} total size of the issue in story points
 */
function calculateTotalSize(issue, onlyResolved) {
  let totalSize = 0;
  issue.children.forEach(child => {
    totalSize+=calculateTotalSize(child, onlyResolved);
  });
  totalSize+= (onlyResolved ? (issue.resolved ? issue.size : 0) : issue.size);
  return totalSize;
}

/**
 * 
 * @param {*} versionId The version ID we're maintaining
 * @param {*} issue The issue we're adding or removing
 * @param {*} addToVersion if true then we add the issue to version, otherwise we remove it
 */
function maintainVersionMap(versionIssueMap, versionId, issue, addToVersion) {
  // Prep for Maintain the version Index Map
  let versionIssueArray = [];
  if (versionIssueMap.hasOwnProperty(versionId)) {
    versionIssueArray = versionIssueMap[versionId];
  } else {
    versionIssueMap[versionId] = versionIssueArray;
  }

  let versionMapIndex = versionIssueArray.findIndex(vIssue => {return vIssue.id == issue.id});
  
  if (addToVersion) {
    if (versionMapIndex == -1) {
      versionIssueArray.push(issue);
    } else {
      console.warn("Tried to add issue " + issue.key + " to version " + versionId + " but issue was already present. Possible event log processing failure.");
    }
  } else {
    if (versionMapIndex == -1) {
      console.warn("Tried to remove issue " + issue.key + " from version " + versionId + " but issue was already removed. Possible event log processing failure.");
    } else {
      versionIssueArray.splice(versionMapIndex, 1);
    }
  }

}

/**
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The range the data should be returned within
 * @param {{datetime: Date, issueId: number, event: string, eventDetails: {issueKey: string, size: number, type: string, parentKey: string, parentId: number, resolution: string, childId: number, versionId: number, versions: number[]}}[]} eventLog a time ordered log of events
 * @param {string} targetId The JIRA ID of the Initiative or Release we want to track the scope change of
 * @param {boolean} isRelease if true, then the ID specified is a Release ID, otherwise it's an initiative ID
 */
function calculateScopeAndBurnupTimeseries(window, eventLog, targetId, isRelease) {

  // Work through the events in time, building up an in-memory record of issues and scope changes
  let scopeData = [];
  let burnupData = [];

  // Dictionary of issueId against issue
  let issuesAtTime = {};
  // Dictionary of issueKey against issue
  let keyToIdMap = {};
  // Total scope of initiative
  let totalSize = 0;
  let previousTotalSize = null;
  // Total burnup of initiative
  let totalDoneSize = 0;
  let previousTotalDoneSize = null;

  // Clear off the version map
  let versionIssueMap = {};

  for (let eventIndex = 0; eventIndex < eventLog.length; eventIndex++) {
    const event = eventLog[eventIndex];

    let eventDateTime = event.datetime;
    // Don't bother processing events after the end of the required range
    if (eventDateTime > window.to) break;

    if (event.event == "created") {
      // Add it to our database
      let issue = {
        id: event.issueId,
        key: event.eventDetails.issueKey,
        type: event.eventDetails.type,
        size: event.eventDetails.size,
        resolved: false,
        parentId: event.eventDetails.parentId,
        parentKey: event.eventDetails.parentKey,
        children: [],
        versions: [...event.eventDetails.versions]
      }

      issuesAtTime[issue.id] = issue;
      keyToIdMap[issue.key] = issue.id;

      // Update the version map
      issue.versions.forEach(versionId => {
        maintainVersionMap(versionIssueMap, versionId, issue, true);
      })

      if (!isRelease && isChildOf(issuesAtTime, keyToIdMap, issue, targetId)) {
        totalSize += calculateTotalSize(issue, false);
      } else if (isRelease && (issue.type == 'Bug' || issue.type == 'Story')) {
        // If it's a story or bug and was created in the taret release then it counts towards the scope
        if (issue.versions.findIndex(v => {return v == targetId}) != -1) {
          totalSize += calculateTotalSize(issue, false);
        }
      }

    } else if (event.event == "parentChange") {
      let issue = issuesAtTime[event.issueId];

      let size = 0;
      let donePoints = 0;
      if (!isRelease) {
        if (isChildOf(issuesAtTime, keyToIdMap, issue, targetId)) {
          size = -calculateTotalSize(issue, false);
          donePoints = -calculateTotalSize(issue, true);
        }
      }

      issue.parentId = event.eventDetails.parentId;

      if (!isRelease) {
        if (isChildOf(issuesAtTime, keyToIdMap, issue, targetId)) {
          size += calculateTotalSize(issue, false);
          donePoints += calculateTotalSize(issue, true);
        }
      }

      totalSize += size;
      totalDoneSize += donePoints;

    } else if (event.event == "sizeChange") {

      let issue = issuesAtTime[event.issueId];

      let previousSize = issue.size;
      issue.size = event.eventDetails.size;

      if ((isRelease && issue.versions.findIndex((value) => {return value == targetId;}) != -1) || (!isRelease && isChildOf(issuesAtTime, keyToIdMap, issue, targetId))) {
        totalSize = totalSize - previousSize + issue.size;
        if (issue.resolved) {
          totalDoneSize = totalDoneSize - previousSize + issue.size;
        }
      }

    } else if (event.event == "addChild") {

      let issue = issuesAtTime[event.issueId];
      let newChild = issuesAtTime[event.eventDetails.childId];

      /**
       * Note: JIRA supports issue deletion which means there could be references to issues
       * that no longer exist. We therefore won't have been able to query them or their history
       * and therefore will not be able to marry them up with what we have recorded.
       */
      if (newChild != null) {
        issue.children.push(newChild);

        if (!isRelease && isChildOf(issuesAtTime, keyToIdMap, issue, targetId)) {
          totalSize += calculateTotalSize(newChild, false);
          totalDoneSize += calculateTotalSize(newChild, true);
        }
      }

    } else if (event.event == "removeChild") {
      let issue = issuesAtTime[event.issueId];

      let childIndex = issue.children.findIndex(child => {return child.issueId == event.eventDetails.childId});
      /**
       * Note: JIRA supports issue deletion which means there could be references to issues
       * that no longer exist. We therefore won't have been able to query them or their history
       * and therefore will not be able to marry them up with what we have recorded.
       */
      if (childIndex != -1) {
        issue.children.splice(childIndex, 1);

        let exChild = issuesAtTime[event.eventDetails.childId];
        if (!isRelease && isChildOf(issuesAtTime, keyToIdMap, issue, targetId)) {
          totalSize -= calculateTotalSize(exChild, false);
          totalDoneSize -= calculateTotalSize(exChild, true);
        }
      }
    } else if (event.event == "resolutionChange") {
      let issue = issuesAtTime[event.issueId];

      // Implement event
      issue.resolved = (event.eventDetails.resolution == "Done");

      // Calculate size changes
      if ((isRelease && issue.versions.findIndex((value) => {return value == targetId;}) != -1 && (issue.type == 'Story' || issue.type == 'Bug')) || (!isRelease && isChildOf(issuesAtTime, keyToIdMap, issue, targetId))) {
        if (issue.resolved) {
          // An issue being done, doesn't mean that it's children are. They're handled independently.
          totalDoneSize += issue.size;
        } else {
          totalDoneSize -= issue.size;
        }
      }
    } else if (isRelease && (event.event == "removeVersion" || event.event == "addVersion")) {
      let issue = issuesAtTime[event.issueId];
      let versionId = event.eventDetails.versionId;
      // Implement event

      // Implement the event
      if (event.event == "addVersion") {
        issue.versions.push(versionId);

        maintainVersionMap(versionIssueMap, versionId, issue, true);
        
      } else {
        let versionIndex = issue.versions.findIndex(version => {return version == versionId});
        if (versionIndex != -1) {
          issue.versions.splice(versionIndex, 1);
        } else {
          console.warn("Tried to remove version " + versionId + " from issue " + issue.key + " but version was not present. Possible event log processing failure.");
        }

        maintainVersionMap(versionIssueMap, versionId, issue, false);
      }

      // Calculate size changes
      if (versionId == targetId) {
        // We only care about bugs and stories when calculating the size of a release. Epics etc. are just containers.
        if (issue.type == 'Story' || issue.type == 'Bug') {
          let sizeToChangeBy = calculateTotalSize(issue, false);
          let doneSizeToChangeBy = calculateTotalSize(issue, true);
          if (event.event == "addVersion") {
            totalSize += sizeToChangeBy;
            totalDoneSize += doneSizeToChangeBy;
          } else {
            totalSize -= sizeToChangeBy;
            totalDoneSize -= doneSizeToChangeBy;
          }
        }
      }
    }

    // Record the scope at this time
    if (totalSize != previousTotalSize) {
      scopeData.push([totalSize, Math.floor(eventDateTime)]);
      previousTotalSize = totalSize;

      // Cross-check version size
      // let vSize = calculateVersionSize(targetId);
      // console.debug(vSize);

    }
    // Record the burnup at this time
    if (totalDoneSize != previousTotalDoneSize) {
      burnupData.push([totalDoneSize, Math.floor(eventDateTime)]);
      previousTotalDoneSize = totalDoneSize;
    }

  }

  // Add an additional point for "now" assuming it's in the date range
  if (window.now >= window.to) {
    burnupData.push([totalDoneSize, Math.floor(window.to)]);
    scopeData.push([totalSize, Math.floor(window.to)]);
  } else {
    burnupData.push([totalDoneSize, Math.floor(window.now)]);
    scopeData.push([totalSize, Math.floor(window.now)]);
  }

  // Update the cache
  let cache = isRelease? gReleaseScopeAndBurnupDataCache : gInitiativeScopeAndBurnupDataCache;
  cache[targetId] = {
    scopeData: scopeData,
    burnupData: burnupData,
    lastUpdateTime: window.now >= window.to ? window.to : window.now
  }

}

/**
 * Note: customfield_10016 = Story Points
 * 
 * @param {Object} issue - JIRA issue object
 * @returns {number} - The size as specified by the Story Points field or a default value if it isn't set
 */
function getIssueSize(issue) {
  let size = issue.fields.customfield_10016;
  if (size == null) {
    return DEFAULT_STORY_SIZE;
  } else {
    return parseInt(size);
  }
}

/**
 * Calculates the cycle time from transition out of the last from status to transition to the first to status. Takes into account regressions within the period.
 * 
 * @param {{fromStatus: string, toStatus: string, datetime: Date}[]} statusChanges - a datetime ascending ordered array of status changes 
 * @param {string[]} fromStatuses
 * @param {string[]} toStatuses
 * @param {Date} toDateTime The date beyond which status changes are in the future and should be disregarded from the calculation
 * @returns {number} - The cycle time as a time difference (in days)
 */ 
function calculateCycleTime(statusChanges, fromStatuses, toStatuses, toDateTime) {
  let firstTimeForFirstStatus;
  // We want the first time that the issues transitioned from a fromStatus to something else
  for (let i = 0; i < statusChanges.length; i++) {
    const statusChange = statusChanges[i];
    // Yes - statusChange.toStatus is correct :)
    if (fromStatuses.includes(statusChange.fromStatus) && !fromStatuses.includes(statusChange.toStatus)) {
      firstTimeForFirstStatus = statusChange.datetime;
      break;
    }
  }
  // If we haven't got a start status, then count it from creation - it was created further down the value stream
  if (firstTimeForFirstStatus == null) firstTimeForFirstStatus = statusChanges[0].datetime;

  let lastTimeForLastStatus;
  for (let i = statusChanges.length - 1; i >= 0; i--) {
    const statusChange = statusChanges[i];
    if (statusChange.datetime <= toDateTime) {
      if (toStatuses.includes(statusChange.toStatus) && !toStatuses.includes(statusChange.fromStatus)) {
        lastTimeForLastStatus = statusChange.datetime;
        break;
      }
    }
  }
  // This function should not have been called with any issues that don't complete, but just in case, just return the toDateTime rather than crash out
  if (lastTimeForLastStatus == null) {
    if(statusChanges)
    lastTimeForLastStatus = statusChanges[statusChanges.length-1].datetime;
  }

  // Return the difference in days
  return (lastTimeForLastStatus.getTime() - firstTimeForFirstStatus.getTime()) / 1000 / 60 / 60 / 24;
}

/**
 * Puts together a map of JIRA issues to a datetime ordered list of status changes the issue transitioned through
 * 
 * @param {Object[]} issues - JIRA issue objects array
 * @returns {Object.<string, {issue: Object, statusChanges: {fromStatus: string, toStatus: string, datetime: Date}[]}>} - dictionary of JIRA issue keys mapped to a datetime ascending ordered array of status changes
 */
function getStatusChangesByIssueKeyMap(issues) {

  let statusChangeMap = {};

  // Loop through each issue and record the datetime at which they transitioned forwards in state
  issues.forEach(issue => {
    // Build up an array of status changes
    let statusChanges = [];
    issue.changelog.histories.forEach(history => {
      let changeDateTime = new Date(history.created);
      history.items.forEach(item => {
        if (item.field == "status") {
          statusChanges.push({ issue: issue, fromStatus: item.fromString, toStatus: item.toString, datetime: changeDateTime });
        }
      });
    });

    statusChangeMap[issue.key] = {issue: issue, statusChanges: statusChanges.sort((a, b) => { return a.datetime - b.datetime })};

  });

  return statusChangeMap;
}

/**
 * Puts together a complete list of JIRA issue transitions (including regressions)
 * 
 * @param {Object[]} issues - JIRA issue objects array
 * @returns {{issue: Object, fromStatus: string, toStatus: string, datetime: Date}[]} - array of JIRA issue transitions ordered by transition datetime
 */
function getStatusChangesList(issues) {

  let statusChangeList = [];

  // Loop through each issue and record the datetime at which they transitioned to Deploy Queue (or later if they jumped)
  issues.forEach(issue => {
    issue.changelog.histories.forEach(history => {
      let changeDateTime = new Date(history.created);
      history.items.forEach(item => {
        if (item.field == "status") {
          statusChangeList.push({issue: issue, fromStatus: item.fromString, toStatus: item.toString, datetime: changeDateTime });
        }
      });
    });
  });

  return statusChangeList.sort((a, b) => { return a.datetime - b.datetime });
}

/**
 * Determines dates of transitions to and from an array of statuses that are considered "complete"
 * 
 * @param {Object.<string, {issue: Object, statusChanges: {fromStatus: string, toStatus: string, datetime: Date}[]}>} statusChangeMap - dictionary of JIRA issue keys mapped to a datetime ascending ordered array of status changes
 * @param {string[]} toStatuses - The completion statuses
 * @param {boolean} completionOnly - if true then only completions (not regressions) are added
 * @return {{completionTransitionDateTime: Date, transitionType: string, issue: *}[]} - array of completion dates against JIRA issue objects that have completed. If they haven't completed, they won't be included.
 */
function getCompletionEvents(statusChangeMap, toStatuses, completionOnly = false) {

  let completionEvents = [];

  // Loop through each issue and record the datetime at which they transitioned to the toStatus (or later if they jumped)
  for (var issueKey in statusChangeMap) {

    var completionEvent;
    statusChangeMap[issueKey].statusChanges.forEach(statusChange => {
      var transitionType;
      let pushIt = false;
      if (toStatuses.includes(statusChange.toStatus) && !toStatuses.includes(statusChange.fromStatus)) {
        transitionType = "completion";
        pushIt = true;
      } else if (!completionOnly && toStatuses.includes(statusChange.fromStatus) && !toStatuses.includes(statusChange.toStatus)) {
        transitionType = "regression";
        pushIt = true;
      } else {
        pushIt = false;
      }
      if (pushIt) {
        completionEvent = {
          completionTransitionDateTime: statusChange.datetime,
          transitionType: transitionType,
          issue: statusChangeMap[issueKey].issue
        };
        completionEvents.push(completionEvent);
      }
    });
  };

  return completionEvents;

}

/**
 * 
 * @param {Object.<string, {issue: Object, statusChanges: {fromStatus: string, toStatus: string, datetime: Date}[]}>} statusChangeMap - dictionary of JIRA issue keys mapped to a datetime ascending ordered array of status changes (including ONLY issues that COMPLETE)
 * @return {number} The average cycle time per point - will return NaN if it's effectively infinity (i.e. nothing's moved)
 */
function calculateAverageCycleTimePerPointForIssues(statusChangeMap, fromStatuses, toStatuses, toDateTime) {

  let totalCycleTimePerPoint = 0;
  let ignoreIssues = 0;
  // For each issue's transitions
  for (var issueKey in statusChangeMap) {
    // Get their cycle time (from transition out of last from status to transition to first to status)
    let cycleTime = calculateCycleTime(statusChangeMap[issueKey].statusChanges, fromStatuses, toStatuses, toDateTime);
    // Divide that cycle time by the ticket size
    let size = getIssueSize(statusChangeMap[issueKey].issue);
    // Ignore "0" point stories in cycle time calculations
    if (size == 0) {
      ignoreIssues++;
    } else {
      let cycleTimePerPoint = cycleTime / size;
      // Add it to the total
      totalCycleTimePerPoint += cycleTimePerPoint;
    }
  };

  // Average them
  return totalCycleTimePerPoint / (Object.keys(statusChangeMap).length - ignoreIssues);

}

function earlierThan(a, b) {
  return STATUSES.indexOf(a) < STATUSES.indexOf(b);
}

function laterThan(a, b) {
  return STATUSES.indexOf(a) > STATUSES.indexOf(b);
}

/**
 * 
 * @param {*[]} issues array of JIRA issues objects
 */
function logStatusChangeListForIssues(issues) {

  // Get the full list of status changes for each of these issues (ordered by datetime)
  let statusChangeList = getStatusChangesList(issues);
  statusChangeList.forEach(statusChange => {
    console.info(statusChange.datetime.toUTCString() + ',' + statusChange.issue.key + ',' + statusChange.fromStatus + ',' + statusChange.toStatus);
  });

}

/**
 * 
 * @param {*} body 
 * @return {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} The window to return data in
 */
function getWindowFromRequest(body) {
  return {
    now: new Date(),
    from: new Date(body.range.from),
    to: new Date(body.range.to),
    intervalMs: body.intervalMs,
    maxDataPoints: body.maxDataPoints
  }
}

/**
 * 
 * @param {*} body 
 * @return {string} request ID, e.g. Q398
 */
function getRequestIDFromRequest(body) {
  return body.requestId;
}

/* ========================== */
/* ROUTES                     */
/* ========================== */

// Should return 200 ok. Used for "Test connection" on the datasource config page.
gApp.get('/',
  passport.authenticate(gAuthenticationStrategy, { session: false }),
  (httpReq, httpRes) => {
    httpRes.set('Content-Type', 'text/plain')
    httpRes.send(new Date() + ': OK')
  })

// Test the connection between Jira and this project
gApp.get('/test-jira',
  passport.authenticate(gAuthenticationStrategy, { session: false }),
  (httpReq, httpRes) => {
    gJira.myself.getMyself().then((jiraRes) => {
      httpRes.json(jiraRes)
    }).catch((jiraErr) => {
      httpRes.json(JSON.parse(jiraErr))
    })
  });

// Used by the find metric options on the query tab in panels.
gApp.all('/search',
  passport.authenticate(gAuthenticationStrategy, { session: false }),
  (httpReq, httpRes) => {

    // At the moment we want to show only 1 metric: 2 week velocity
    httpRes.json(METRICS);

  });

// Should return metrics based on input.
gApp.post('/query',
  passport.authenticate(gAuthenticationStrategy, { session: false }), 
  (httpReq, httpRes) => {

    let result = [];
    let window = getWindowFromRequest(httpReq.body);
    let requestId = getRequestIDFromRequest(httpReq.body);

    let p = [];
    httpReq.body.targets.forEach(target => {
      let ps = getPromisesForMetric(requestId, window, target, result);
      if (ps != null) {
        if (Array.isArray(ps)) {
          p.push(...ps);
        } else {
          p.push(ps);
        }
      }
    });
    
    // Once all promises resolve, return result
    Promise.all(p).then(() => {
      httpRes.json(result)
    });

  });

gApp.listen(3030)

console.info('Server is listening on port 3030')