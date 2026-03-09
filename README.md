# MCP Sumo Logic

A Model Context Protocol (MCP) server that integrates with Sumo Logic's API to perform log searches.

## Features



## Environment Variables

```env
ENDPOINT=https://api.au.sumologic.com/api/v1  # Sumo Logic API endpoint
SUMO_API_ID=your_api_id                       # Sumo Logic API ID
SUMO_API_KEY=your_api_key                     # Sumo Logic API Key
```

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the required environment variables
4. Build the project:
   ```bash
   npm run build
   ```
5. Start the server:
   ```bash
   npm start
   ```

## Docker Setup

1. Build the Docker image:
   ```bash
   docker build -t mcp/sumologic .
   ```

2. Run the container (choose one method):

   a. Using environment variables directly:
   ```bash
   docker run -e ENDPOINT=your_endpoint -e SUMO_API_ID=your_api_id -e SUMO_API_KEY=your_api_key mcp/sumologic
   ```

   b. Using a .env file:
   ```bash
   docker run --env-file .env mcp/sumologic
   ```

   Note: Make sure your .env file contains the required environment variables:
   ```env
   ENDPOINT=your_endpoint
   SUMO_API_ID=your_api_id
   SUMO_API_KEY=your_api_key
   ```

## Error Handling

 