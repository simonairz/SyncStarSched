const fs = require('fs');
const readline = require('readline');
const moment = require('moment');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const config = require('./config.json');
const secrets = require('./secrets.json');

const colors = {
    Black:  "\x1b[30m" + "%s" + "\x1b[0m",
    White:  "\x1b[37m" + "%s" + "\x1b[0m",
    Red:    "\x1b[31m" + "%s" + "\x1b[0m",
    Green:  "\x1b[32m" + "%s" + "\x1b[0m",
    Yellow: "\x1b[33m" + "%s" + "\x1b[0m",
    Blue:   "\x1b[34m" + "%s" + "\x1b[0m",
};

// launch program with async iife
(async () => {

    const oAuth2Client = await getOAuthClient()
    
    const schedule = await scrapeSite()

    await syncSchedule(oAuth2Client, schedule)

})()

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

async function scrapeSite() {
    // open browse and navigate to page
    const browser = await puppeteer.launch({headless: true, devtools: false}); // update config in prod
    const page = await browser.newPage();
    await page.goto(config.urls.starbucks);

    // get initial page status
    await page.waitForSelector("input.textbox")
    pageStatus = await getPageStatus(page);

    // keep smashing buttons until we're on schedule page
    while (!pageStatus.schedulePage) {
     
        if (pageStatus.partnerPage) {
            await page.focus("input.textbox.txtUserid")
            await page.keyboard.type(secrets.partnerId)

        } else if (pageStatus.passwordPage) {
            await page.focus("input.textbox.tbxPassword")
            await page.keyboard.type(secrets.password)

        } else if (pageStatus.securityPage) {
            const securityAnswer = secrets.securityPrompts[pageStatus.securityQuestion];
            await page.focus("input.textbox.tbxKBA")
            await page.keyboard.type(securityAnswer)
        }

        // submit form
        page.click("input[type='submit']:not(.aspNetDisabled)")

        // wait for navigation and dom and check page
        await page.waitForNavigation({waitUntil: 'networkidle2'});
        await page.waitForSelector("input.textbox,.scheduleShift")
        pageStatus = await getPageStatus(page);
    }


    // go hunting for info we want
    var webShifts = await page.evaluate(() => {

        // executes on client in browser
        var shifts = $(".scheduleShift").map(function() {
            var $this = $(this)
            var $store = $this.find(".scheduleShiftStore");
            var $time = $this.find(".scheduleShiftTime");
            var day = $this.closest(".scheduleDayRight").find(".scheduleDayTitle").text().trim()
            var storeLink = $store.attr("href")
            var storeText = $store.text()
            var storeNumber = storeText.split(",")[0].split("#")[1].trim()
            var storeName = storeText.split(",").slice(1).join(",").trim()
            var shiftText = $time.text().trim();
            var shiftStart = shiftText.split("-")[0].trim()
            var shiftEnd = shiftText.split("-")[1].trim()

            return {
               storeNumber,
               storeName,
               day,
               shiftStart,
               shiftEnd,
               storeLink
            }

         }).get();

         return shifts;
    })

    // var sampleShift = {
    //     "storeNumber": "007629",
    //     "storeName": "Burlington Town Center",
    //     "day": "Friday, January 11",
    //     "shiftStart": "12:30 PM",
    //     "shiftEnd": "06:00 PM"
    // }

    // log events for fun
    console.log(colors.Yellow, `Retrieved ${webShifts.length} shift(s) from Starbucks:`)
    webShifts.forEach(shift => {
        console.log(`Shift: ${shift.day}, ${shift.shiftStart}`);
    });
    console.log("\r\n")

    // Closing Time
    await browser.close();

    return webShifts
}

// determine what page we're on
async function getPageStatus(myPage) {
    return await myPage.evaluate(() => {
            
        const partner = document.querySelectorAll(".txtUserid")
        const passBox = document.querySelectorAll("input.tbxPassword")
        const secQuestion = document.querySelector(".bodytext.lblKBQ.lblKBQ1")
        const schedule = document.querySelectorAll(".scheduleShift")

        var status = {
            partnerPage: partner.length > 0,
            schedulePage: schedule.length > 0,
            passwordPage: passBox.length > 0,
            securityPage: !!secQuestion,
            securityQuestion: secQuestion ? secQuestion.innerText : ""
        }

        return status;

    })
}

async function syncSchedule(auth, schedule) {
    
    // init google api library
    const calendar = google.calendar({ version: 'v3', auth });

    const calendarId = await getCalendarId(calendar, "Starbucks")

    // check current events
    const eventsRes = await calendar.events.list({
        calendarId: calendarId,
        timeMin: (new Date()).toISOString(),
        maxResults: 99,
        singleEvents: true,
        orderBy: 'startTime',
    })
    
    const upcomingEvents = eventsRes.data.items;

    // log events for fun
    console.log(colors.Yellow, `Retrieved ${upcomingEvents.length} upcoming calendar appointment(s):`)
    upcomingEvents.forEach(event => {
        console.log(`Event: ${event.start.dateTime || event.start.date} - ${event.summary}`);
    });
    console.log("\r\n")

    const defaultEvent = {  
        'summary': 'Starbucks Shift',
        'location': '49 Church St #2072, Burlington, VT 05401',
        'description': 'Automatically added from https://mysite.starbucks.com/MySchedule/Schedule.aspx.',
        'start': {
          'dateTime': '2019-01-01T12:00:00-05:00',
          'timeZone': 'America/New_York'
        },
        'end': {
          'dateTime': '2019-01-01T17:00:00-05:00',
          'timeZone': 'America/New_York'
        },
        'reminders': {
          'useDefault': false,
          'overrides': [
            {'method': 'popup', 'minutes': 60 * 4},
            {'method': 'popup', 'minutes': 60},
            {'method': 'popup', 'minutes': 15}
          ]
        }
    }

    // find new shifts
    for (let i=0; i < schedule.length; i++) {
        const shift = schedule[i];

        // upcoming shift year is current execution year unless we're in dec and shift is in jan
        shift.year = (new Date()).getFullYear()
        if (new Date().getMonth() == 11 && shift.day.includes("Jan")) shift.year++

        shift.startDateTime = `${shift.day.split(",")[1]} ${shift.year}, ${shift.shiftStart}`
        shift.endDateTime = `${shift.day.split(",")[1]} ${shift.year}, ${shift.shiftEnd}`
        shift.startMoment = moment(shift.startDateTime, "MMMM D YYYY, hh:mm A")
        shift.endMoment = moment(shift.endDateTime, "MMMM D YYYY, hh:mm A")
        shift.duration = moment.duration(shift.endMoment.diff(shift.startMoment));

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

    for (let i=0; i < schedule.length; i++) {
        const shift = schedule[i];

        if (shift.isNew && shift.inFuture) {

            let insertShift = Object.assign({}, defaultEvent)
            insertShift.start.dateTime = shift.startMoment.format()
            insertShift.end.dateTime = shift.endMoment.format()
            insertShift.summary = `(${shift.duration.asHours()}HR) Starbucks`
            insertShift.location = `${shift.storeName} - #${shift.storeNumber}`

            let insertRes = await calendar.events.insert({
                calendarId: calendarId,
                requestBody: insertShift,
            })

            console.log(`Inserted: ${shift.day}, ${shift.start}`);
            // todo - send update if requested
        }
    }
    console.log("\r\n")



    // find deleted events
    for (let i = 0; i < upcomingEvents.length; i++) {
        const evt = upcomingEvents[i];
        
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
        const evt = upcomingEvents[i];
        
        await calendar.events.delete({
            calendarId: calendarId,
            eventId: evt.id,
        })

        console.log(`Deleted: ${evt.start.dateTime}`);
    }

}

async function getCalendarId(calendar, calendarName) {

    // call all active calendars to look for this one
    const calRes = await calendar.calendarList.list({})
    const calendars = calRes.data.items;
    const myCal = calendars.filter(cal => cal.summary == calendarName)[0];
    const calendarId = myCal.id; // "60m640rj25mngq7m57j0hbg518@group.calendar.google.com"

    return calendarId;
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 */
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
};

function writeJsonAsync(filePath, obj) {
    return new Promise(
        (resolve) => {
            fs.writeFile(filePath, JSON.stringify(obj), (err) => {
                if (err) resolve({ ok: false, err });
                resolve({ok: true, data: {msg: `Object stored to ${filePath}`}})
            })
       }
     );
};

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
