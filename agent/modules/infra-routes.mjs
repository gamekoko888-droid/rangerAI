
// ─── Alert Webhook Handler (receives from Alertmanager) ───
function handleAlertWebhook(req, res) {
  try {
    const payload = req.body;
    const alerts = payload?.alerts || [];
    const status = payload?.status || 'unknown';
    
    for (const alert of alerts) {
      const severity = alert.labels?.severity || 'info';
      const alertname = alert.labels?.alertname || 'unknown';
      const summary = alert.annotations?.summary || '';
      const description = alert.annotations?.description || '';
      
      if (alert.status === 'firing') {
        logger.warn('[AlertWebhook] Alert FIRING', { alertname, severity, summary });
      } else {
        logger.info('[AlertWebhook] Alert RESOLVED', { alertname, severity, summary });
      }
    }
    
    res.json({ status: 'ok', processed: alerts.length });
  } catch (err) {
    logger.error('[AlertWebhook] Failed to process alert', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal error' });
  }
}
