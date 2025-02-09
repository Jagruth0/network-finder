import express from "express";
import pg from "pg";
import bodyParser from "body-parser";
import passport from "passport";
import session from "express-session";
import GoogleStrategy from "passport-google-oauth2";
import env from "dotenv";
import {GoogleGenerativeAI} from "@google/generative-ai";
import nodemailer from "nodemailer";
import Imap from "imap";
import {simpleParser} from "mailparser";

const app = express();
const port = 3000;
env.config();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    secure: 'true',
    auth: {
        user: process.env.EMAIL_ID,
        pass: process.env.EMAIL_PASSWORD
    }
});

const imap = new Imap({
  user: process.env.EMAIL_ID,
  password: process.env.EMAIL_PASSWORD,
  host: 'imap.gmail.com',
  port: 993,
  tls: true
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: true,
        cookie:{
            maxAge: 1000 *60 *60 *24,
        }
    })
);
app.use(bodyParser.urlencoded({extended:true}));
app.use(express.static("public"));

app.use(passport.initialize());
app.use(passport.session());

const db = new pg.Client({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
});
db.connect();

//-----------GET REQUESTS-----------------

app.get("/login", (req, res)=> {
    res.render("login.ejs");
});

app.get("/", (req, res)=>{
    res.redirect("/login");
});

app.get("/home", (req, res)=> {
    console.log(req.user);
    if (req.isAuthenticated()) {
        res.render("home.ejs");
    } else {
        res.redirect("/login");
    }
});

app.get("/home/result", (req, res)=> {
    if(req.isAuthenticated()){
        if (req.session.que) {
            res.render("result.ejs", {result: req.session.ans});
        } else {
            res.redirect("/home");
        }
    } else{
        res.redirect("/login");
    }
});

app.get(
    "/auth/google",
    passport.authenticate("google", {
        scope:["profile", "email"],
        // prompt: "select_account",
    })
);

app.get(
    "/auth/google/home",
    passport.authenticate("google", {
        successRedirect: "/home",
        failureRedirect: "/login",
    })
);

app.get("/logout", (req, res)=> {
    req.logout((err)=> {
        if(err) console.log(err);
        res.redirect("/login");
    })
});
//---------POST REQUESTS--------------------

app.post("/home/api", async(req, res)=>{
    const que = req.body.query;
    // console.log(que);
    const mentors = await db.query("SELECT * FROM mentors");
    const tabledata = JSON.stringify(mentors.rows, null, 2);
    var ans = "";

    const userdata = await db.query("SELECT * FROM users WHERE email = $1", [req.user.email]);
    const usercreds = userdata.rows[0].credits;
    //------------------
    if (usercreds) {
        const prompt =`Depending on the following query: ${que}, categorize the investor/mentor to specific category from the data:${tabledata} and return only the name to which the category belongs to.`;
        const result = await model.generateContent(prompt);
        console.log(result.response.text());
        await db.query("UPDATE users SET credits=$1 WHERE email =$2", [usercreds-1, req.user.email]);
        ans = result.response.text();
    } else {
        ans = "Your credits are exhausted. Please check your email to recharge."

        //---------------------New Mail----------------------
        var mailOptions = {
            from: process.env.EMAIL_ID,
            to: req.user.email,
            subject: 'recharge 5 credits',
            text: 'Your credits for network finder have reached 0. To recharge with 5 more credits send an email to' + process.env.EMAIL_ID + 'with subject as: "recharge 5 credits".'
        };
        transporter.sendMail(mailOptions, function(error, info){
            if (error) {
              console.log(error);
            } else {
              console.log('Email sent: ' + info.response);
            }
        }); 
    }
    //--------------------
    req.session.ans = ans;
    req.session.que = que;
    res.redirect("/home/result");
});


//--------------------------Update user creds---------------------


async function UpdateCreds(presentmail) {
    const userdata = await db.query("SELECT * FROM users WHERE email = $1", [presentmail]);
    const usercreds = userdata.rows[0].credits;
    if(usercreds)
        return;

    await db.query("UPDATE users SET credits = $1 WHERE email = $2", [5, presentmail]);
}



//----------------------------READ MAIL--------------------------


//----------------------Parsing the mail contents----------------------
function readMail(f) {
    f.on('message', (msg, seqno) => {
        // console.log(`Message #${seqno}:`);

        msg.on('body', (stream) => {
          let buffer = '';
          stream.on('data', (chunk) => {
            buffer += chunk.toString();
          });

          stream.on('end', () => {
            simpleParser(buffer, (err, parsed) => {
              if (err) {
                console.log(err);
              } else {
                return parsed;
              }
            });
          });
        });
    });
    f.once('end', () => {
        // console.log('Done fetching emails');
        // imap.end();
    });
}


imap.once('ready', () => {
    imap.openBox('INBOX', true, (err, box) => {
        if (err) console.log(err);

        imap.search(['UNSEEN', ['SUBJECT','recharge 5 credits']], async (err, results) => {
            if (err)  console.log(err);
            if (results && results.length > 0) {
                imap.setFlags(results, ['\\Seen'], function(err) {});
                // Your custom code here
                const f = imap.fetch(results, {bodies: ['HEADER.FIELDS (FROM SUBJECT)'], struct: true});
                const mailParsed = readMail(f);
                const fromEmail = mailParsed.from.value[0].address;
                UpdateCreds(fromEmail);
                //----------------------------
            }
        });
        
//-------------------------------------Look for new Emails received------------------------------------

        imap.on('mail', (newMails) => {
            // console.log(newMails + ' new mails received.');
            const f = imap.fetch(box.messages.total + ':*', {
              bodies: ['HEADER.FIELDS (FROM SUBJECT)'],
              struct: true,
            });
            const mailParsed = readMail(f);
            const fromEmail = mailParsed.from.value[0].address;
            if(mailParsed.subject === 'recharge 5 credits'){
                UpdateCreds(fromEmail);
            }
        });
    })
});

imap.once('error', (err) => {
    console.log(err);
});



//--------Authentication & Session-----------

passport.use(
    "google",
    new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "http://localhost:3000/auth/google/home",
        userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
    }, async (accessToken, refreshToken, profile, cb) =>{
        // console.log(profile);
        try {
            const result = await db.query("SELECT * FROM users WHERE email = $1", [profile.email]);
            if(result.rows.length == 0){
                const newUser = await db.query("INSERT INTO users VALUES ($1, $2)", [profile.email, 5]);
                cb(null, newUser.rows[0]);
            }else{
                cb(null, result.rows[0]);
            }
        } catch (err) {
            cb(err);
        }
    })
);

passport.serializeUser((user, cb) => {
    cb(null, user);
});
passport.deserializeUser((user, cb)=> {
    cb(null, user);
});

imap.connect();

app.listen(port, ()=> {
    console.log(`Running on port ${port}`);
});