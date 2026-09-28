(() => {
  'use strict';

  const instances = new Map();
  let pendingUploads = 0;
  const sourceChoiceOrder = ['运营', '产品', '研发', '设计', '安全合规', '用户反馈', '商务合作'];
  const DESCRIPTION_HELP_TEXT = '填写要求（举例）\n\n- 背景 -\nO_KR2：2025年Q4平均月订单30万；\n抖音电商/短视频带货逐步占据40%以上电商市场，通过新的渠道拉升订单增量；\n\n- 目标 -\n日均提升订单量5%\n\n- 需求 -\n支持抖音电商返现，用户可以通过返现购买抖音电商的商品，并获得返现；';
  const DESCRIPTION_GUIDANCE_HTML = `
    <div class="description-guidance__head"><strong>规范说明</strong><button type="button" class="description-guidance__collapse">收起</button></div>
    <div class="description-guidance__content">
      <section><h3>需求背景</h3><p>简要说明需求的来源、触发因素及当前问题。为后续目标设定及相关同学判断需求、制定策略提供参考依据。</p><p><b>核心问题</b>：业务/用户痛点是什么？市场或内部环境发生了什么变化？现有方案存在哪些缺陷？</p><p><b>背景描述示例</b>：当前电商平台的订单取消率高达15%，主要问题为：</p><ul><li>支付流程需跳转3次页面，操作繁琐；</li><li>支付失败后无明确错误提示，导致用户重复尝试；</li><li>移动端支付成功率比PC端低20%。</li></ul><p>观测到竞品A近期上线“一键支付”功能，支付成功率显著提升，主因为链路缩短，体验升级。</p></section>
      <section><h3>需求目标</h3><p>有明确的定性改进方向，则描述方向，需与背景问题直接关联；有明确的可量化结果，则描述量化结果。</p><p><b>核心场景</b>：解决什么问题？预期效果如何衡量？优先级或关键指标是什么？</p><p><b>目标描述示例</b>：降低支付操作步骤，明确错误提示。提高用户的支付成功率，通过优化漏斗链路，订单取消率有下降空间。</p></section>
      <section><h3>需求内容</h3><p><b>示例</b></p><ul><li>支付操作步骤从3步减少至1步，由输入地址调整为选择地址，缩短用户路径。</li><li>明确错误提示：支付失败时显示具体原因（如网络超时、余额不足）。</li></ul></section>
    </div>`;
const HELP_ICON_SVG = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M512 0.44544C229.47712 0.44544 0.44544 229.47712 0.44544 512.00256c0 282.5216 229.03168 511.552 511.55456 511.552s511.55456-229.03168 511.55456-511.552C1023.55456 229.47712 794.52288 0.44544 512 0.44544zM512 900.78336c-47.08736 0-85.25952-39.41632-85.25952-88.03584S464.91264 724.7104 512 724.7104c47.0848 0 85.25696 39.41632 85.25696 88.03712S559.08608 900.78336 512 900.78336zM578.2016 583.85536c0 48.6208-26.94528 88.03456-60.18304 88.03456l-12.03584 0c-33.23904 0-60.18304-39.41376-60.18304-88.03456L409.6896 231.71584c0-48.6208 26.944-88.032 60.18176-88.032l84.25728 0c33.23904 0 60.18304 39.41248 60.18304 88.032L578.2016 583.85536z" fill="#ff447c"></path></svg>';
  const FULLSCREEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"></path></svg>';

  const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const imageDataUrl = (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('图片读取失败，请重新选择')); reader.onload = () => resolve(String(reader.result || '')); reader.readAsDataURL(file); });
  const uploadImage = async (file, insertFn) => { const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']; if (!allowedTypes.includes(file.type) || file.size > 5 * 1024 * 1024) { alert('请选择 5 MB 以内的 PNG、JPG、WebP 或 GIF 图片'); return; } pendingUploads += 1; try { const payload = await window.BRMS?.repo?.uploads?.image(await imageDataUrl(file)); if (!payload?.url) throw new Error('图片上传失败，请稍后重试'); insertFn(payload.url, file.name, ''); requestAnimationFrame(() => instances.forEach(syncEditor)); } catch (error) { alert(error.message || '图片上传失败，请稍后重试'); } finally { pendingUploads -= 1; } };

  const syncEditor = (record) => {
    if (!record?.source?.isConnected) return;
    record.source.innerHTML = record.editor.getHtml();
    record.source.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const exitFullscreen = (record, focus = false) => {
    if (!record?.fullscreenLayer) return;
    syncEditor(record);
    record.placeholder?.replaceWith(record.shell);
    record.fullscreenLayer.remove();
    record.fullscreenLayer = null;
    record.placeholder = null;
    if (!document.querySelector('.wang-editor-fullscreen-layer')) document.body.classList.remove('wang-editor-fullscreen-open');
    if (focus) record.editor.focus();
  };

  const enterFullscreen = (record) => {
    if (record.fullscreenLayer) return;
    const layer = document.createElement('section');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    const close = document.createElement('button');
    record.placeholder = document.createComment(`wang-editor:${record.source.id}`);
    record.shell.before(record.placeholder);
    layer.className = 'wang-editor-fullscreen-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', '全屏富文本编辑器');
    header.className = 'wang-editor-fullscreen-header';
    title.textContent = record.source.closest('.form-row')?.querySelector(':scope > label')?.textContent.trim().replace(/\s+/g, ' ') || '富文本编辑器';
    close.type = 'button';
    close.className = 'wang-editor-fullscreen-exit';
    close.innerHTML = `${FULLSCREEN_ICON}<span>退出全屏</span>`;
    close.onclick = () => exitFullscreen(record, true);
    header.append(title, close);
    layer.append(header, record.shell);
    document.body.append(layer);
    record.fullscreenLayer = layer;
    document.body.classList.add('wang-editor-fullscreen-open');
    requestAnimationFrame(() => record.editor.focus());
  };

  const destroyEditor = (record) => {
    exitFullscreen(record);
    syncEditor(record);
    record.editor.destroy();
    record.shell.remove();
    record.source.hidden = false;
    instances.delete(record.source.id);
  };

  const mountEditor = (source) => {
    if (!window.wangEditor || source.dataset.wangEditorMounted === 'true') return;
    const wrapper = source.closest('.rich-editor');
    if (!wrapper) return;
    const prior = instances.get(source.id);
    if (prior) destroyEditor(prior);

    const shell = document.createElement('div');
    const toolbarMount = document.createElement('div');
    const editableMount = document.createElement('div');
    const action = document.createElement('button');
    shell.className = 'wang-editor-shell';
    toolbarMount.className = 'wang-editor-toolbar';
    editableMount.className = 'wang-editor-content';
    action.type = 'button';
    action.className = 'wang-editor-fullscreen-toggle';
    action.title = '全屏编辑';
    action.setAttribute('aria-label', '全屏编辑');
    action.innerHTML = FULLSCREEN_ICON;
    shell.append(toolbarMount, editableMount);
    source.hidden = true;
    source.dataset.wangEditorMounted = 'true';
    wrapper.replaceChildren(shell, source);

    let record;
    const editor = window.wangEditor.createEditor({
      selector: editableMount,
      html: source.innerHTML,
      mode: 'default',
      config: {
        placeholder: source.dataset.placeholder || '请输入内容',
        MENU_CONF: { uploadImage: { allowedFileTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxFileSize: 5 * 1024 * 1024, customUpload: uploadImage } },
        onChange() { syncEditor(record); }
      }
    });
    window.wangEditor.createToolbar({
      editor,
      selector: toolbarMount,
      mode: 'default',
      config: {
        toolbarKeys: ['headerSelect', 'bold', 'italic', 'underline', 'through', 'color', 'bgColor', '|', 'bulletedList', 'numberedList', 'todo', 'blockquote', 'codeBlock', '|', 'insertLink', 'uploadImage', 'insertTable', '|', 'undo', 'redo']
      }
    });
    toolbarMount.append(action);
    record = { source, shell, editor, action, fullscreenLayer: null, placeholder: null };
    instances.set(source.id, record);
    action.onclick = () => enterFullscreen(record);
  };

  const enhanceEditors = (root = document) => root.querySelectorAll('.rich-editor .editor-content[id]').forEach(mountEditor);

  const enhanceChoiceTags = (form, selector, groupLabel) => {
    const select = form.querySelector(selector);
    if (!select || select.dataset.choiceTagsEnhanced === 'true') return;
    const available = [...select.options].filter((option) => option.value);
    const options = selector === '#source' ? sourceChoiceOrder.map((value) => available.find((option) => option.value === value)).filter(Boolean) : available;
    if (!options.length) return;
    select.dataset.choiceTagsEnhanced = 'true';
    select.classList.add('choice-tags__native-control');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    const group = document.createElement('div');
    group.className = 'choice-tags';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', groupLabel);
    group.innerHTML = options.map((option) => `<button type="button" class="choice-tags__item${option.selected ? ' is-selected' : ''}" role="radio" aria-checked="${option.selected}" data-choice-value="${escapeHtml(option.value)}">${escapeHtml(option.textContent.trim())}</button>`).join('');
    const selectValue = (value, focus) => {
      select.value = value;
      group.querySelectorAll('.choice-tags__item').forEach((button) => {
        const selected = button.dataset.choiceValue === value;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-checked', String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (focus && selected) button.focus();
      });
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    group.querySelectorAll('.choice-tags__item').forEach((button) => {
      button.onclick = () => selectValue(button.dataset.choiceValue, false);
      button.onkeydown = (event) => {
        const buttons = [...group.querySelectorAll('.choice-tags__item')];
        const current = buttons.indexOf(button);
        const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
        if (!direction) return;
        event.preventDefault();
        selectValue(buttons[(current + direction + buttons.length) % buttons.length].dataset.choiceValue, true);
      };
    });
    select.insertAdjacentElement('afterend', group);
    (group.querySelector('.is-selected') || group.querySelector('.choice-tags__item')).tabIndex = 0;
  };

  const enhanceRequirementForm = () => {
    const form = document.querySelector('#form');
    if (!form || form.dataset.enhanced === 'true') return;
    form.dataset.enhanced = 'true';
    form.classList.add('requirement-form');
    enhanceChoiceTags(form, '#source', '需求来源');
    enhanceChoiceTags(form, '#project', '所属项目');
    form.querySelectorAll('.help').forEach((help) => {
      help.removeAttribute('title');
      help.dataset.tooltip = DESCRIPTION_HELP_TEXT;
      help.setAttribute('role', 'img');
      help.setAttribute('aria-label', DESCRIPTION_HELP_TEXT);
      help.innerHTML = HELP_ICON_SVG;
    });
    const row = form.querySelector('#desc')?.closest('.form-row');
    if (row && !row.dataset.guidanceEnhanced) {
      row.dataset.guidanceEnhanced = 'true';
      row.classList.add('description-guidance-row');
      const toggle = document.createElement('button');
      const panel = document.createElement('aside');
      toggle.type = 'button';
      toggle.className = 'description-guidance-toggle';
      toggle.textContent = '规范说明';
      toggle.setAttribute('aria-expanded', 'false');
      panel.className = 'description-guidance';
      panel.setAttribute('aria-label', '需求详细描述规范说明');
      panel.innerHTML = DESCRIPTION_GUIDANCE_HTML;
      row.querySelector(':scope > label')?.insertAdjacentElement('afterend', toggle);
      row.append(panel);
      const close = () => { row.classList.remove('is-guidance-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '规范说明'; };
      toggle.onclick = () => { const open = row.classList.toggle('is-guidance-open'); toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? '隐藏说明' : '规范说明'; };
      panel.querySelector('.description-guidance__collapse').onclick = close;
    }
    form.querySelectorAll('.form-row').forEach((row) => {
      const label = row.querySelector(':scope > label');
      const control = row.querySelector(':scope > input, :scope > select, :scope > .rich-editor');
      if (label && control?.id) label.htmlFor = control.id;
      if (row.classList.contains('wide')) row.classList.add('form-row-prominent');
    });
  };

  const destroyAll = () => [...instances.values()].forEach(destroyEditor);
  document.addEventListener('submit', () => instances.forEach(syncEditor), true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') [...instances.values()].forEach((record) => exitFullscreen(record, true)); });
  document.addEventListener('brms:page-rendered', (event) => { destroyAll(); if (['create', 'edit'].includes(event.detail?.view)) { enhanceRequirementForm(); enhanceEditors(); } });
  document.addEventListener('brms:modal-rendered', (event) => enhanceEditors(event.detail?.modal || document));
  window.BRMS_EDITOR = {
    enhance: enhanceEditors,
    destroyAll,
    syncAll: () => instances.forEach(syncEditor),
    getHtml: (id) => instances.get(id)?.editor.getHtml() || document.getElementById(id)?.innerHTML || '',
    hasPendingUploads: () => pendingUploads > 0
  };
  enhanceRequirementForm();
  enhanceEditors();
})();
