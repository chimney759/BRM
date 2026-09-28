(() => {
  const pad = (value) => String(value).padStart(2, '0');

  const formatDateTime = (value) => {
    if (!value) return '-';

    const raw = String(value).trim();
    const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
    if (localMatch) return `${localMatch[1]} ${localMatch[2]}:${localMatch[3] || '00'}`;

    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw.replace('T', ' ').replace(/\.\d+(?:Z|[+-]\d{2}:?\d{2})?$/, '').replace(/Z$/, '');

    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});

    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  };

  // Presentation only: APIs keep UTC ISO strings for concurrency checks and portability.
  window.BRMS_TIME = Object.freeze({ formatDateTime });
})();
