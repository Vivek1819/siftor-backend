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
const wss = new WebSocketServer({ server });
const port = 5000;

app.use(cors());
app.use(express.json());

const MAX_PAGES = 1000; 

wss.on('connection', (ws) => {
    console.log('Websocket connected');

    ws.on('close', () => {
        console.log('Websocket disconnected');
    });

    ws.on('message', async (message) => {
        const { url } = JSON.parse(message);
        console.log('Scraping URL:', url);

        if (!url) {
            console.log('No URL provided');
            ws.send(JSON.stringify({ error: 'URL is required' }));
            return;
        }

        let browser;
        try {
            browser = await puppeteer.launch();
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
                ws.send(JSON.stringify({ visiting: currentUrl })); // Emit the currently visiting URL

                try {
                    await page.goto(currentUrl, { waitUntil: 'networkidle2' });
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

            ws.send(JSON.stringify({ scrapedData }));

        } catch (error) {
            console.error('Unexpected Error:', error);
            ws.send(JSON.stringify({ error: 'An unexpected error occurred.' }));
            if (browser) {
                await browser.close();
            }
        }
    });
});

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});