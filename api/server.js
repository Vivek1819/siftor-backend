import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio'; 
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';
import http from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const server = http.createServer(app);
// Configure WebSocket with heartbeat to prevent disconnections
const wss = new WebSocketServer({ 
  server,
  // Enable CORS for all origins
  verifyClient: (info, cb) => {
    cb(true);
  }
});

const port = process.env.PORT || 5000;

// Configure standard CORS for HTTP routes
app.use(cors({
  origin: '*', // Allow all origins
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  preflightContinue: false,
  optionsSuccessStatus: 204
}));
app.use(express.json());

const MAX_PAGES = 1000;

// Implement WebSocket ping/pong to keep connections alive
function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws) => {
    console.log('Websocket connected');
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    // Send immediate welcome message to confirm connection
    try {
        ws.send(JSON.stringify({ status: 'connected' }));
    } catch (e) {
        console.error('Error sending welcome message:', e);
    }

    ws.on('close', () => {
        console.log('Websocket disconnected');
    });

    ws.on('message', async (message) => {
        let msgData;
        try {
            msgData = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON message received:', e);
            ws.send(JSON.stringify({ error: 'Invalid message format' }));
            return;
        }

        const { url } = msgData;
        console.log('Scraping URL:', url);

        if (!url) {
            console.log('No URL provided');
            ws.send(JSON.stringify({ error: 'URL is required' }));
            return;
        }

        let browser;
        try {
            browser = await puppeteer.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();
            const visitedUrls = new Set();
            const urlQueue = [url];
            const scrapedData = [];

            const baseUrl = new URL(url).origin;
            console.log('Base URL:', baseUrl);

            while (urlQueue.length > 0 && visitedUrls.size < MAX_PAGES) {
                const currentUrl = urlQueue.shift();
                if (visitedUrls.has(currentUrl)) {
                    continue;
                }

                console.log(`Visiting URL: ${currentUrl}`);
                try {
                    ws.send(JSON.stringify({ visiting: currentUrl }));
                } catch (e) {
                    console.error('Error sending visiting message:', e);
                    break; // Stop if we can't communicate with the client
                }

                try {
                    await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                } catch (error) {
                    console.error(`Failed to navigate to ${currentUrl}:`, error);
                    continue; // Skip this URL and continue with the next one
                }

                const content = await page.content();
                const $ = cheerio.load(content);

                const pageData = [];
                let currentSection = { title: "", content: [] };

                $('h1, h2, h3, h4, h5, h6, p, span, li, pre, code').each((_, element) => {
                    const tag = $(element).prop('tagName').toLowerCase();
                    const text = $(element).text().trim();

                    if (text) {
                        if (tag.startsWith('h')) {
                            if (currentSection.content.length > 0) {
                                pageData.push(currentSection);
                            }
                            currentSection = { title: text, content: [] };
                        } else {
                            currentSection.content.push({ tag, text });
                        }
                    }
                });

                if (currentSection.content.length > 0) {
                    pageData.push(currentSection);
                }

                scrapedData.push({ url: currentUrl, data: pageData });

                $('a[href]').each((_, element) => {
                    const link = $(element).attr('href');
                    if (link && !visitedUrls.has(link)) {
                        try {
                            const absoluteLink = new URL(link, baseUrl).href;
                            if (absoluteLink.startsWith(baseUrl)) {
                                urlQueue.push(absoluteLink);
                            }
                        } catch (e) {
                            // Ignore invalid URLs
                        }
                    }
                });

                visitedUrls.add(currentUrl);
            }

            console.log('Closing Puppeteer...');
            await browser.close();

            try {
                ws.send(JSON.stringify({ scrapedData }));
            } catch (e) {
                console.error('Error sending final scraped data:', e);
            }

        } catch (error) {
            console.error('Unexpected Error:', error);
            try {
                ws.send(JSON.stringify({ error: 'An unexpected error occurred.' }));
            } catch (e) {
                console.error('Error sending error message:', e);
            }
            if (browser) {
                await browser.close();
            }
        }
    });
});

// Set up the ping interval to keep connections alive
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating inactive WebSocket connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {
      console.error('Error pinging client:', e);
      ws.terminate();
    }
  });
}, 30000); // Ping every 30 seconds

wss.on('close', function close() {
  clearInterval(interval);
});

// Add a health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'OK', clients: wss.clients.size });
});

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});