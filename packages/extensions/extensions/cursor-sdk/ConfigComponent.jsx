({ config, updateConfig, ui }) => {
  const { Input } = ui;

  const handleApiKeyChange = (e) => {
    updateConfig({ ...config, apiKey: e.target.value });
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        label="Cursor API Key"
        type="password"
        value={config?.apiKey || ''}
        onChange={handleApiKeyChange}
        placeholder="cursor_..."
      />
      <p className="text-xs text-text-secondary -mt-2">
        Get your key from{' '}
        <a href="https://cursor.com/dashboard" target="_blank" rel="noopener noreferrer" className="underline">
          cursor.com/dashboard
        </a>
        . Falls back to CURSOR_API_KEY env var if empty.
      </p>
    </div>
  );
};
