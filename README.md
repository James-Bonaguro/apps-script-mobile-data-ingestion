# Edge-to-Enterprise Data Ingestion POC

This repository contains the front-end Proof of Concept (POC) for a zero-cost, serverless data ingestion pipeline. It is designed to demonstrate how unstructured edge data (voice, field notes, mobile uploads) can be routed directly into a structured enterprise environment (Google Workspace) for AI synthesis.

## Architecture

Edge Capture (The PWA): A frictionless, React-based Progressive Web App optimized for mobile. Bypasses traditional database friction.

Serverless Middleware (Google Apps Script): A secure, zero-cost webhook that receives JSON payloads from the edge app.

Data Lake (Google Docs): Unstructured text and transcripts are dynamically appended to a centralized Google Document.

AI Synthesis (NotebookLM): Google NotebookLM is mapped to the Google Drive folder, indexing the live document for instant RAG (Retrieval-Augmented Generation) querying.

## Tech Stack

Front-End: React 18, Tailwind CSS (via CDN for zero-build deployment).

Back-End API: Google Apps Script (Serverless).

Storage & Compute: Google Drive / Google NotebookLM.

## Deployment

This project is configured as a standalone index.html file for instant, zero-configuration deployment on Vercel or Netlify.

## Workflow Execution

User dictates or types a note into the web interface.

App fires a POST request to the Apps Script endpoint.

Apps Script authenticates and appends the payload to the target Google Doc.

User queries NotebookLM: "Summarize my field notes from today."
