P02 GPT-5.5 knowledge-base dedupe plan
1. Locate the active RangerAI knowledge base data source.
2. Read schema and current knowledge_entries rows.
3. Classify duplicates by normalized title, normalized content, and normalized title+content.
4. If duplicates exist, back up the DB and remove only non-canonical duplicates.
5. If no duplicates exist, perform no data deletion and document validation evidence.
