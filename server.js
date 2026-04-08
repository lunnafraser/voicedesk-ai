require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Initialize Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Initialize Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Google Calendar setup
let calendar;
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    calendar = google.calendar({ version: 'v3', auth });
    console.log('Google Calendar initialized successfully');
  } catch (err) {
    console.warn('Google Calendar setup failed:', err.message);
  }
}

// In-memory conversation store (per call)
const conversations = new Map();

// Business configuration from environment variables
const BUSINESS_CONFIG = {
  name: process.env.BUSINESS_NAME || 'Our Business',
  hours: process.env.BUSINESS_HOURS || 'Monday to Friday, 9 AM to 5 PM',
  address: process.env.BUSINESS_ADDRESS || '',
  phone: process.env.BUSINESS_PHONE || '',
  services: process.env.BUSINESS_SERVICES || '',
  transferNumber: process.env.TRANSFER_NUMBER || '',
  calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  greeting: process.env.CUSTOM_GREETING || '',
};

// System prompt for Claude
const SYSTEM_PROMPT = `You are a friendly, professional AI receptionist for ${BUSINESS_CONFIG.name}. 
Your role is to:
1. Greet callers warmly and professionally
2. Answer questions about the business (hours, location, services)
3. Take messages when staff are unavailable
4. Help schedule appointments when requested
5. Transfer calls to the right person when needed
6. Handle common inquiries with helpful, concise responses

Business Details:
- Name: ${BUSINESS_CONFIG.name}
- Hours: ${BUSINESS_CONFIG.hours}
${BUSINESS_CONFIG.address ? '- Address: ' + BUSINESS_CONFIG.address : ''}
${BUSINESS_CONFIG.services ? '- Services: ' + BUSINESS_CONFIG.services : ''}

Guidelines:
- Keep responses SHORT (1-3 sentences max) since this is a phone conversation
- Be warm, natural, and conversational
- If asked to schedule an appointment, collect: name, preferred date/time, reason for visit
- If asked to leave a message, collect: caller name, phone number, and message
- If asked to transfer, confirm and proceed
- If you don't know something, offer to take a message or transfer to someone who can help
- Never reveal that you are an AI unless directly asked`;

// Helper: Get AI response from Claude
async function getAIResponse(callSid, userMessage) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, []);
  }
  const history = conversations.get(callSid);
  history.push({ role: 'user', content: userMessage });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const assistantMessage = response.content[0].text;
    history.push({ role: 'assistant', content: assistantMessage });

    const actions = parseActions(assistantMessage);
    return { text: assistantMessage, actions };
  } catch (err) {
    console.error('Claude API error:', err.message);
    return {
      text: "I'm sorry, I'm having a little trouble right now. Let me transfer you to someone who can help.",
      actions: { transfer: true },
    };
  }
}

// Parse AI response for actionable items
function parseActions(text) {
  const actions = {};
  const lowerText = text.toLowerCase();
  if (lowerText.includes('[transfer]') || lowerText.includes('transferring you now')) {
    actions.transfer = true;
  }
  if (lowerText.includes('[schedule]')) {
    actions.schedule = true;
  }
  if (lowerText.includes('[message]')) {
    actions.takeMessage = true;
  }
  return actions;
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'VoiceDesk AI Receptionist',
    business: BUSINESS_CONFIG.name,
    calendarEnabled: !!calendar,
  });
});

// Incoming call handler
app.post('/voice/incoming', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;

  console.log(`Incoming call: ${callSid} from ${req.body.From}`);

  const greeting =
    BUSINESS_CONFIG.greeting ||
    `Thank you for calling ${BUSINESS_CONFIG.name}. How can I help you today?`;

  conversations.set(callSid, [
    { role: 'assistant', content: greeting },
  ]);

  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/respond',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
  });

  gather.say({ voice: 'Polly.Joanna' }, greeting);

  twiml.say({ voice: 'Polly.Joanna' }, "I didn't catch that. Please go ahead and I'm listening.");
  twiml.redirect('/voice/incoming');

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle caller speech and respond
app.post('/voice/respond', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;

  console.log(`[${callSid}] Caller said: "${speechResult}"`);

  if (!speechResult) {
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice/respond',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
    });
    gather.say({ voice: 'Polly.Joanna' }, "Sorry, I didn't catch that. Could you please repeat?");
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const aiResponse = await getAIResponse(callSid, speechResult);
  console.log(`[${callSid}] AI response: "${aiResponse.text}"`);

  if (aiResponse.actions.transfer && BUSINESS_CONFIG.transferNumber) {
    twiml.say({ voice: 'Polly.Joanna' }, "One moment, I'll transfer you now.");
    twiml.dial(BUSINESS_CONFIG.transferNumber);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  let responseText = aiResponse.text
    .replace(/\[transfer\]/gi, '')
    .replace(/\[schedule\]/gi, '')
    .replace(/\[message\]/gi, '')
    .trim();

  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/respond',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
  });

  gather.say({ voice: 'Polly.Joanna' }, responseText);

  twiml.say({ voice: 'Polly.Joanna' }, 'Are you still there? Feel free to ask me anything.');
  twiml.redirect('/voice/incoming');

  res.type('text/xml');
  res.send(twiml.toString());
});

// Call status callback
app.post('/voice/status', (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;
  console.log(`[${callSid}] Call status: ${status}`);

  if (status === 'completed' || status === 'failed' || status === 'no-answer') {
    conversations.delete(callSid);
    console.log(`[${callSid}] Conversation cleared`);
  }

  res.sendStatus(200);
});

// Google Calendar: List available slots
app.get('/calendar/available', async (req, res) => {
  if (!calendar) {
    return res.status(503).json({ error: 'Google Calendar not configured' });
  }

  try {
    const now = new Date();
    const endOfWeek = new Date(now);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: endOfWeek.toISOString(),
        items: [{ id: BUSINESS_CONFIG.calendarId }],
      },
    });

    const busySlots = response.data.calendars[BUSINESS_CONFIG.calendarId].busy;
    res.json({ busySlots, timeRange: { start: now, end: endOfWeek } });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar availability' });
  }
});

// Google Calendar: Create appointment
app.post('/calendar/book', async (req, res) => {
  if (!calendar) {
    return res.status(503).json({ error: 'Google Calendar not configured' });
  }

  const { summary, description, startTime, endTime, attendeeEmail } = req.body;

  try {
    const event = {
      summary: summary || 'Appointment (booked via AI receptionist)',
      description: description || 'Booked through VoiceDesk AI',
      start: { dateTime: startTime, timeZone: process.env.TIMEZONE || 'America/New_York' },
      end: { dateTime: endTime, timeZone: process.env.TIMEZONE || 'America/New_York' },
    };

    if (attendeeEmail) {
      event.attendees = [{ email: attendeeEmail }];
    }

    const response = await calendar.events.insert({
      calendarId: BUSINESS_CONFIG.calendarId,
      requestBody: event,
    });

    console.log('Appointment booked:', response.data.htmlLink);
    res.json({ success: true, eventId: response.data.id, link: response.data.htmlLink });
  } catch (err) {
    console.error('Booking error:', err.message);
    res.status(500).json({ error: 'Failed to book appointment' });
  }
});

// Messages endpoint (for reviewing taken messages)
const messages = [];

app.post('/messages', (req, res) => {
  const { callerName, callerPhone, message, callSid } = req.body;
  const newMessage = {
    id: Date.now(),
    callerName,
    callerPhone,
    message,
    callSid,
    timestamp: new Date().toISOString(),
  };
  messages.push(newMessage);
  console.log('New message saved:', newMessage);
  res.json({ success: true, message: newMessage });
});

app.get('/messages', (req, res) => {
  res.json({ messages });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VoiceDesk AI Receptionist running on port ${PORT}`);
  console.log(`Business: ${BUSINESS_CONFIG.name}`);
  console.log(`Calendar: ${calendar ? 'Enabled' : 'Disabled'}`);
  console.log(`Transfer number: ${BUSINESS_CONFIG.transferNumber || 'Not set'}`);
});
