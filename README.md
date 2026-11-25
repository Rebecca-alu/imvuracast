# ImvuraCast - Farm Weather Planner

ImvuraCast is a web app that helps farmers plan their work using the weather. "Imvura" means rain in Kinyarwanda.
You search for a town and the app shows the next 5 days of weather, with advice on the whether each day is good for planting, spraying, harvesting or watering crops.

**Live app:** https://imvuracast.rebecca-alu.tech/                                **Demo video:**                                       **Author:** Rebecca Umuragwa Benegusenga

## Why I built it

Most weather apps only show numbers like millimetres of rain or wind speed, and a farmer still has to work out what they mean.
ImvuraCast turns those numbers into simple advice, for example "Too windy, spray will drift".

## Features 
 
- Search for any town and pick the right one when serveral places share a name
- A card for each day  with temperature, rain, chance of rain, wind, humidity, farm advice and warnings
- a field day score from 0 to 100 for how good each day is for farm work
- Sort days by date, best day, rain, temperature or wind, and filter them by activity or dry/rainy days 
- A rain and temperature chart, plus a table with the forecast every 3 hours
- Saved places, a °C/°F switch, and a badge that shows  which server answered

## API and credits

This app uses the **OpenWeatherMap API** by OpenWeather Ltd.
- Geocoding API (turn a town name into coordinates): https://openweathermap.org/api/geocoding-api
- 5 day / 3 hour Forecast API (the weather data): https://openweathermap.org/forecast5
- Weather icons: https://openweathermap.org/weather-conditions
- I also used Node.js, Express, dotenv, Nginx, HAProxy and MDN Web Docs.

## How it works

The browser never talks to OpenWeatherMap directly. It asks my server, which adds the secret API key, gets the
weather, groups it into days and adds the advice. This keeps the key private.

```
Browser -> Lb01 (HAProxy) -> Web01 or Web02 (Nginx -> Node.js app) -> OpenWeatherMap
```
Files: `server.js` (the server), `public/` (the web page), `test.js` (tests), `.env.example` (API key template), `.gitignore`, 
`Dockerfile` and `.github/workflows/ci.yml` (automatic tests on GitHub).

## How to run it on your computer

You need Node.js 18 or newer, Git, and a free API key from https://home.openweathermap.org/api_keys.
```bash
git clone https://github.com/Rebecca-alu/imvuracast.git
cd imvuracast
npm install
cp .env.example .env
```
Open `.env`, replace `your_api_key_here` with your key, then run `npm start` and open http://localhost:3000. Run the tests with `npm test`.

## How I deployed it on Web01 and Web02

I did these steps on 7250-web-01 (3.8.48.55), then the same steps on 7250-web-02 (3.10.235.40).

**1.** Connect with `ssh ubuntu@3.8.48.55`, then install Node.js, Git and Nginx:
```bash
sudo apt update && curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs git nginx
```
**2.** Download the app and install its packages:
```bash
cd /home/ubuntu
git clone https://github.com/YOUR_GITHUB_USERNAME/imvuracast.git
cd imvuracast
npm install --omit=dev
```
**3.** Create the key file with `cp .env.example .env`, add the key with `nano .env`, and protect it with `chmod 600 .env`.

**4.** Create `/etc/systemd/system/imvuracast.service` so the app keeps running and restarts by itself:
```
[Unit]
Description=ImvuraCast
After=network.target
[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/imvuracast
EnvironmentFile=/home/ubuntu/imvuracast/.env
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=multi-user.target
```
Start it with `sudo systemctl daemon-reload` and `sudo systemctl enable --now imvuracast`.


**5.** Create `/etc/nginx/sites-available/imvuracast` so Nginx sends visitors from port 80 to the app:
```
server {
    listen 80 default_server;
    add_header X-Served-By $hostname always;
    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
}
```
Enable it with `sudo ln -s /etc/nginx/sites-available/imvuracast /etc/nginx/sites-enabled/`, remove the old default
site, check it with `sudo nginx -t` and reload with `sudo systemctl reload nginx`.

## How I configured the load balancer (Lb01)
On 7250-lb-01 (3.8.4.221) I installed HAProxy with `sudo apt install -y haproxy` and added this to `/etc/haproxy/haproxy.cfg`:
```
frontend imvuracast_front
    bind *:80
    mode http
    default_backend imvuracast_back
backend imvuracast_back
    mode http
    balance roundrobin
    option httpchk GET /api/health
    server 7250-web-01 3.8.48.55:80 check
    server 7250-web-02 3.10.235.40:80 check
```
`roundrobin` sends each request to the next server in turn, and `httpchk` stops sending visitors to a server that is
down. I checked the file with `sudo haproxy -c -f /etc/haproxy/haproxy.cfg` and ran `sudo systemctl restart haproxy`.
 
**Testing:** running `curl http://3.8.4.221/api/health` several times shows the server name switching between 7250-web-01 and 7250-web-02. The badge at the top of the web page changes in the same way.

## Error handling and security

- Clear messages instead of crashes when a town is not found, the input is wrong, the weather service is down or slow, there are too many requests, or the user is offline
- The API key is only in the `.env` file on the servers and is never uploaded to GitHub
- Input is checked on the page and on the server, and text is shown safely to block XSS attacks
- Each visitor can make up to 60 requests per minute, and answers are saved for 10 minutes to use fewer API calls

## Challenges I faced

1. The API gives a forecast every 3 hours, not one per day, so I grouped them by date and calculated daily totals.
2. To keep the API key out of the browser, I made the browser call my own server instead of OpenWeatherMap.
3. Many towns share a name, so the app shows a list to choose from.
4. To see which server was answering, I added the `X-Served-By` header and the `/api/health` page.
5. Port 80 was already used by Nginx's default page, so I removed it and added my own configuration.

© 2026 Rebecca Umuragwa Benegusenga – MIT License
