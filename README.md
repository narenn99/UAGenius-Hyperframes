# UA Genius HyperFrames Prototype

Prototype flow:

1. Choose a creative generation card.
2. Enter a prompt and optionally upload an image.
3. The backend asks OpenAI to generate an HTML/CSS/JS composition.
4. HyperFrames renders that composition into an MP4.
5. The app shows the generated video with a download button.

## Local Run

```bash
OPENAI_API_KEY="your_key" OPENAI_MODEL="gpt-4.1" npm start
```

Then open:

```text
http://127.0.0.1:4173
```

## Required Environment Variables

```text
OPENAI_API_KEY=your OpenAI API key
OPENAI_MODEL=gpt-4.1
PORT=4173
HOST=0.0.0.0
```

## Railway Deployment

1. Push this folder to GitHub.
2. In Railway, create a new project from the GitHub repository.
3. Railway should use the included `Dockerfile`.
4. Add environment variables:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL=gpt-4.1`
   - `HOST=0.0.0.0`
   - `PORT=4173`
5. Deploy and open the Railway public URL.

For the fastest recruiter demo, the Railway URL can serve both frontend and backend.
