const fs = require('fs');
const readline = require('readline');
const moment = require('moment');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const config = require('./config.json');
const secrets = require('./secrets.json');

const colors = {
    Bright: "\x1b[1m"  + "%s" + "\x1b[0m",
    Dim:    "\x1b[2m"  + "%s" + "\x1b[0m",
    Black:  "\x1b[30m" + "%s" + "\x1b[0m",
    White:  "\x1b[37m" + "%s" + "\x1b[0m",
    Red:    "\x1b[31m" + "%s" + "\x1b[0m",
    Green:  "\x1b[32m" + "%s" + "\x1b[0m",
    Yellow: "\x1b[33m" + "%s" + "\x1b[0m",
    Blue:   "\x1b[34m" + "%s" + "\x1b[0m",
};

const defaultEvent = {  
    'summary': 'Starbucks Shift',
    'location': '49 Church St #2072, Burlington, VT 05401',
    'description': `Automatically added from ${config.urls.starbucks}.`,
    'start': {
      'dateTime': '2019-01-01T12:00:00-05:00',
      'timeZone': 'America/Chicago'
    },
    'end': {
      'dateTime': '2019-01-01T17:00:00-05:00',
      'timeZone': 'America/Chicago'
    },
    'reminders': {
      'useDefault': false,
      'overrides': [
        {'method': 'popup', 'minutes': 60 * 4},
        {'method': 'popup', 'minutes': 60},
        {'method': 'popup', 'minutes': 15}
      ]
    }
};

// launch program with async iife
(async () => {

    const calendarApi = await getCalendarApi()
    
    const upcomingEvents = await getCalendarEvents(calendarApi)
    
    const schedule = await scrapeStarbucks()

    await syncSchedule(calendarApi, schedule, upcomingEvents)

})()

async function scrapeStarbucks() {
    // open browse and navigate to page
    const browser = await puppeteer.launch({headless: false, devtools: true}); // update config in prod
    const page = await browser.newPage();
    await page.goto(config.urls.starbucks);

    // get initial page status
    await page.waitForSelector("input.textbox")
    
    pageStatus = await getPageStatus(page);
    console.log(page.url());
    // keep smashing buttons until we're on schedule page
    var passPage=false;
    while (!pageStatus.schedulePage) {
        //console.log("While Loop- "+page.url() + pageStatus);
        if (pageStatus.partnerPage) {
            console.log("Entering Partner Numbers");
            await page.focus("input.textbox.txtUserid")
            await page.keyboard.type(secrets.partnerId)
            page.click("input[class='sa-2019-button']")
        } else if (pageStatus.passwordPage && !passPage) {
            console.log("Entering password");
            await page.focus(".textbox.tbxPassword")
            await page.keyboard.type(secrets.password)
            page.click("input[type='submit']")
            passPage = true;
            await page.waitForNavigation({waitUntil: 'networkidle0'});
            await page.waitForNavigation({waitUntil: 'networkidle0'});
            console.log("Network loaded")
            await page.waitForSelector('div.ellipsis');
            console.log("On Schedule Page")
        } else if (pageStatus.securityPage) {
            console.log("Entering Security Questions");
            const securityAnswer = secrets.securityPrompts[pageStatus.securityQuestion];
            console.log("Question-"+pageStatus.securityQuestion+"\tAnswer-"+securityAnswer);
            await page.focus("input.textbox.tbxKBA")
            await page.keyboard.type(securityAnswer)
            page.click("input[type='submit']")
        }

        // submit form
        

        // wait for navigation and dom and check page
        
        
        if(!passPage){
            await page.waitForNavigation({waitUntil: 'networkidle2'});
            await page.waitForSelector("input.textbox,.scheduleShift")
            pageStatus = await getPageStatus(page);
        }
        
        //console.log("Page changed");
        
    }
    console.log("before navigation await");
    await page.waitForNavigation({waitUntil: 'networkidle0'});
    console.log("before selector await");
    //await page.waitForTimeout(2000); // Wait for 2 seconds
    try{
        await page.waitForSelector('div.ellipsis');
    }catch(e){
        console.log(colors.Red,e);
    }
    

    // await page.waitForNetworkIdle()
    // go hunting for info we want
    try{

    
    var webShifts = await page.evaluate(() => {
        console.log("page Eval")
        // executes on client in browser
        var shifts = $(".Job-time-ellipsis").map(function() {
            var $this = $(this)
            //var $store = $this.find(".scheduleShiftStore");
            var dayRanges = $this.find("#textfield-1026-inputEl").text();
            var dayStartRange = dayRanges.split("-")[0].trim()
            
            var dayRaw = $this.find(".Job-time-ellipsis").parentElement.parentElement.parentElement.parentElement.id;
            const r = /\d+/;
            var day = parseint(dayRaw.match(r)) - 1756 + dayStartRange;
            //var storeLink = $store.attr("href")
            //var storeText = $store.text()
            //var storeNumber = storeText.split(",")[0].split("#")[1].trim()
            //var storeName = storeText.split(",").slice(1).join(",").trim()
            var $time = $this.find(".Job-time-ellipsis");
            var shiftText = $time.text().trim();
            var shiftStart = shiftText.split("-")[0].trim()
            var shiftEnd = shiftText.split("-")[1].trim()

            //grabs date ranges

            console.log(
                "$this-" + $this + "\n" +
                "$time-" + $time + "\n" +
                "dayRanges-" + dayRanges + "\n" +
                "dayStartRange-" + dayStartRange + "\n" +
                "dayRaw- " + dayRaw + "\n" +
                "day-" + day + "\n" +
                "shiftText" + shiftText + "\n" +
                "shiftStart" + shiftStart + "\n" +
                "shiftEnd" + shiftEnd + "\n"
            );
            return {
               //storeNumber,
               //storeName,
               day,
               shiftStart,
               shiftEnd
               //storeLink
            }

         }).get();
         //console.log(shifts);
         return shifts;
    })
    }catch(e){
        console.log("Error-");
        console.log(e);
    }

    // transform retrieved schedules
    for (let i=0; i < webShifts.length; i++) {
        const shift = webShifts[i];

        // upcoming shift year is current execution year unless we're in dec and shift is in jan
        shift.year = (new Date()).getFullYear()
        if (new Date().getMonth() == 11 && shift.day.includes("Jan")) shift.year++

        shift.startDateTime = `${shift.day.split(",")[1]} ${shift.year}, ${shift.shiftStart}`
        shift.endDateTime = `${shift.day.split(",")[1]} ${shift.year}, ${shift.shiftEnd}`
        shift.startMoment = moment(shift.startDateTime, "MMMM D YYYY, hh:mm A")
        shift.endMoment = moment(shift.endDateTime, "MMMM D YYYY, hh:mm A")
        shift.duration = moment.duration(shift.endMoment.diff(shift.startMoment));
    }     


    // log events for fun
    console.log(colors.Yellow, `Retrieved ${webShifts.length} shift(s) from Starbucks:`)
    webShifts.forEach(shift => {
        console.log(shift.startMoment > moment() ? colors.Bright : colors.White,
                    `Shift: ${shift.startMoment.format("ddd, MMM DD, hh:mma")} to ${shift.endMoment.format("hh:mma")}`.replace(/\ 0/g, '  '));
    });
    console.log("\r\n")

    // Closing Time
    await browser.close();

    return webShifts
}
async function getPageStatus(myPage) {
    // determine what page we're on
    //console.log("Running Page Status");
    try{
        return await myPage.evaluate(() => {
            //console.log("Pre-eval Stage")
            const partner = document.querySelector(".textbox.txtUserid")
            //console.log("partner-"+partner)
            const passBox = document.querySelector(".textbox.tbxPassword")
            //console.log("password-"+passBox)
            const secQuestion = document.querySelector(".bodytext.lblKBQ.lblKBQ1.field-label")
            //console.log("question-"+secQuestion)
            const schedule = document.querySelectorAll("div.Job-time-ellipsis")
            //console.log(colors.Green, schedule);
            console.log(schedule);
            var status = {
                partnerPage: !!partner,
                schedulePage: schedule.length > 0,
                passwordPage: !!passBox,
                securityPage: !!secQuestion,
                securityQuestion: secQuestion ? secQuestion.innerText : ""
            }
            console.log("arr-" + schedule);
            console.log("schedulePage"+ status.schedulePage);
            // console.log("passwordPage"+ status.passwordPage)
            // console.log("securityPage"+ status.securityPage)
            console.log("securityQuestion"+ status.securityQuestion);
            return status;

        })
    }catch(e){
        console.log("Error Happened")
        var status = {
            partnerPage: false,
            schedulePage: false,
            passwordPage: false,
            securityPage: false,
            securityQuestion: false
        }
        
        console.error(e);
        return status;
    }
}


async function getCalendarApi() {
    const oAuth2Client = await getOAuthClient()
    
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

    return calendar
}
async function getOAuthClient() {
    // get developer API from credentials.json file
    const credResponse = await readJsonAsync(config.paths.creds)
    if (credResponse.err) console.error(`Error loading file ${credPath}`);
    
    // destructure credentials
    const credentials = credResponse.data
    const { client_secret, client_id, redirect_uris } = credentials.installed;

    // setup oAuth Client
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // get user permission from token.json file
    const tokenResponse = await readJsonAsync(config.paths.token)

    // if we don't have a token file, create one
    const token = tokenResponse.err ? await getAccessToken(oAuth2Client) : tokenResponse.data;

    // authorize client for use    
    oAuth2Client.setCredentials(token);

    return oAuth2Client
}
async function getAccessToken(oAuth2Client) {

    // prompt for online authorization
    const authUrl = oAuth2Client.generateAuthUrl({access_type: 'offline', scope: config.scope});
    console.log('Authorize this app by visiting this url:', authUrl);

    // get response from user
    const authCode = await readlineAskAsync('Enter the code from that page here: ')

    // get token from auth client
    const tokenResponse = await oAuth2Client.getToken(authCode)
    if (tokenResponse.res.statusText != "OK") console.error("Could not retrieve token")

    // Store the token to disk for later program executions
    await writeJsonAsync(config.paths.token, tokenResponse.tokens)

    return tokenResponse.tokens;
}


async function getCalendarEvents(calendar) {

    const calendarId = secrets.cal.id || await getCalendarId(calendar, secrets.cal.name)

    // check current events
    const eventsRes = await calendar.events.list({
        calendarId: calendarId,
        timeMin: (new Date()).toISOString(),
        maxResults: 99,
        singleEvents: true,
        orderBy: 'startTime',
    })
    
    const upcomingEvents = eventsRes.data.items;

    // log events 
    console.log(colors.Yellow, `Retrieved ${upcomingEvents.length} upcoming calendar appointment(s):`)
    upcomingEvents.forEach(event => {
        console.log(`Event: ${moment(event.start.dateTime).format("ddd, MMM DD, hh:mma")} to ${moment(event.end.dateTime).format("hh:mma")}`.replace(/\ 0/g, '  '));
    });
    console.log("\r\n")

    return upcomingEvents;
}
async function getCalendarId(calendar, calendarName) {
     // call all active calendars to look for this one
     const calRes = await calendar.calendarList.list({})
     const calendars = calRes.data.items;
     const myCal = calendars.filter(cal => cal.summary == calendarName)[0];
     const calendarId = myCal.id; // "60m640rj25mngq7m57j0hbg518@group.calendar.google.com"
 
     return calendarId;

}


async function syncSchedule(calendar, schedule, upcomingEvents) {

    const calendarId = secrets.cal.id || await getCalendarId(calendar, secrets.cal.name)

    // find new shifts
    for (let i=0; i < schedule.length; i++) {
        let shift = schedule[i];

        var matchedEvent = upcomingEvents.some(evt => {
            return moment(evt.start.dateTime).format() == shift.startMoment.format() &&
                   moment(evt.end.dateTime).format() == shift.endMoment.format()
        })

        shift.isNew = !matchedEvent
        shift.inFuture = shift.startMoment > moment()
        shift.shouldInsert = shift.isNew && shift.inFuture
    }
    
    // insert new shifts
    var insertShifts = schedule.filter(s=> s.shouldInsert)
    console.log(colors.Green, `Inserting ${insertShifts.length} new shift(s):`)

    for (let i=0; i < insertShifts.length; i++) {
        let shift = insertShifts[i];

        let insertShift = Object.assign({}, defaultEvent)
        insertShift.start.dateTime = shift.startMoment.format()
        insertShift.end.dateTime = shift.endMoment.format()
        insertShift.summary = `(${shift.duration.asHours()}HR) Starbucks`
        //insertShift.location = `${shift.storeName} - #${shift.storeNumber}`

        let insertRes = await calendar.events.insert({
            calendarId: calendarId,
            requestBody: insertShift,
        })

        console.log(`Inserted: ${shift.startMoment.format("ddd, MMM DD, hh:mma")} to ${shift.endMoment.format("hh:mma")}`.replace(/\ 0/g, '  '));
        // todo - send update if requested
    }
    console.log("\r\n")


    // find deleted events
    for (let i = 0; i < upcomingEvents.length; i++) {
        let evt = upcomingEvents[i];
        
        var matchedShift = schedule.some(shift => {
            return moment(evt.start.dateTime).format() == shift.startMoment.format() &&
                   moment(evt.end.dateTime).format() == shift.endMoment.format()
        })

        evt.shouldDelete = !matchedShift
    }


    // delete events
    var deleteShifts = upcomingEvents.filter(e=> e.shouldDelete)
    console.log(colors.Red, `Deleting ${deleteShifts.length} removed event(s):`)
    for (let i = 0; i < deleteShifts.length; i++) {
        let evt = deleteShifts[i];
        
        await calendar.events.delete({
            calendarId: calendarId,
            eventId: evt.id,
        })

        console.log(`Deleted: ${moment(evt.start.dateTime).format("ddd, MMM DD, hh:mma")} to ${moment(evt.end.dateTime).format("hh:mma")}`.replace(/\ 0/g, '  '));
    }

}


function readJsonAsync(filePath) {
    return new Promise(
        (resolve) => {
            fs.readFile(filePath, (err, content) => {
                if (err) {
                    resolve({ err })
                } else {
                   resolve({data: JSON.parse(content)}) 
                }
            })
       }
     );
}
function writeJsonAsync(filePath, obj) {
    return new Promise(
        (resolve) => {
            fs.writeFile(filePath, JSON.stringify(obj), (err) => {
                if (err) resolve({ ok: false, err });
                resolve({ok: true, data: {msg: `Object stored to ${filePath}`}})
            })
       }
     );
}
function readlineAskAsync(question) {
    return new Promise(
        (resolve) => {
            // create readline
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
        
            // await code from user
            rl.question(question, (answer) => {
                rl.close(); // close as soon as we get a response
                resolve(answer)
            });
       }
     );
}
