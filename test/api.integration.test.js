const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const port = 32147;
const databasePath = path.join(os.tmpdir(), `brms-api-test-${process.pid}.sqlite`);
const uploadPath = path.join(os.tmpdir(), `brms-api-test-uploads-${process.pid}`);
let processHandle;

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('API did not become ready');
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'Content-Type': 'application/json', 'X-BRMS-Demo-Role': 'admin', ...(options.headers || {}) },
    ...options
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

test.before(async () => {
  fs.rmSync(databasePath, { force: true });
  fs.rmSync(uploadPath, { recursive: true, force: true });
  processHandle = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, BRMS_API_PORT: String(port), BRMS_DB_PATH: databasePath, BRMS_UPLOAD_DIR: uploadPath, BRMS_DEMO_AUTH: '1' },
    stdio: 'ignore'
  });
  await waitForApi();
});

test.after(() => {
  processHandle?.kill();
  fs.rmSync(databasePath, { force: true });
  fs.rmSync(uploadPath, { recursive: true, force: true });
});

test('uploaded rich-text images are stored, served, and retained in requirements', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLJ0QAAAABJRU5ErkJggg==';
  const requesterHeaders = { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' };
  const uploaded = await request('/api/uploads/images', { method: 'POST', headers: requesterHeaders, body: JSON.stringify({ dataUrl: image }) });
  assert.equal(uploaded.response.status, 201);
  assert.match(uploaded.payload.url, /^\/uploads\/[a-f0-9-]+\.png$/);

  const asset = await fetch(`http://127.0.0.1:${port}${uploaded.payload.url}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/png');

  const project = (await request('/api/projects')).payload.find((item) => item.name === '返现业务');
  const requirement = await request('/api/requirements', { method: 'POST', headers: requesterHeaders, body: JSON.stringify({ title: '富文本图片展示验证', source: '运营', projectId: project.id, descriptionHtml: `<p>图片说明</p><img src="${uploaded.payload.url}" alt="验证图片"><img src="https://example.com/untrusted.png">` }) });
  assert.equal(requirement.response.status, 201);
  assert.match(requirement.payload.descriptionHtml, new RegExp(`<img src="${uploaded.payload.url}" alt="验证图片"`));
  assert.equal(requirement.payload.descriptionHtml.includes('example.com'), false);

  const integrity = await request('/api/integrity/rich-text-assets');
  assert.equal(integrity.response.status, 200);
  assert.equal(integrity.payload.unclaimed.some((asset) => asset.url === uploaded.payload.url), true);
  assert.equal(integrity.payload.missing.some((asset) => asset.url === uploaded.payload.url), false);

  const anotherRequesterHeaders = { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' };
  const sameIdentityUpload = await request('/api/uploads/images', { method: 'POST', headers: anotherRequesterHeaders, body: JSON.stringify({ dataUrl: image }) });
  const sameIdentityRequirement = await request('/api/requirements', { method: 'POST', headers: anotherRequesterHeaders, body: JSON.stringify({ title: '非默认身份富文本图片验证', source: '用户反馈', projectId: project.id, descriptionHtml: `<img src="${sameIdentityUpload.payload.url}" alt="同一身份图片">` }) });
  assert.equal(sameIdentityUpload.response.status, 201);
  assert.equal(sameIdentityRequirement.response.status, 201);

  const otherUserUpload = await request('/api/uploads/images', { method: 'POST', headers: anotherRequesterHeaders, body: JSON.stringify({ dataUrl: image }) });
  const foreignReference = await request('/api/requirements', { method: 'POST', headers: requesterHeaders, body: JSON.stringify({ title: '不可引用他人图片', source: '运营', projectId: project.id, descriptionHtml: `<p>验证权限</p><img src="${otherUserUpload.payload.url}" alt="他人图片">` }) });
  assert.equal(foreignReference.response.status, 201);
  assert.match(foreignReference.payload.descriptionHtml, new RegExp(otherUserUpload.payload.url));

  const duplicateReference = await request('/api/requirements', { method: 'POST', headers: requesterHeaders, body: JSON.stringify({ title: '图片可跨需求复用', source: '运营', projectId: project.id, descriptionHtml: `<img src="${otherUserUpload.payload.url}" alt="共享图片">` }) });
  assert.equal(duplicateReference.response.status, 201);

  const invalid = await request('/api/uploads/images', { method: 'POST', body: JSON.stringify({ dataUrl: 'data:image/png;base64,bm90LWFuLWltYWdl' }) });
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.payload.code, 'VALIDATION_ERROR');
});

test('users can hold multiple workflow roles while retaining a compatible primary role', async () => {
  const created = await request('/api/users', {
    method: 'POST',
    body: JSON.stringify({ name: '张三', department: '增长部', roles: ['业务需求方', '产品'], status: '启用' })
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.payload.roles, ['业务需求方', '产品']);
  assert.equal(created.payload.role, '业务需求方');
  assert.match(created.payload.initialPassword, /^.{1,16}$/);
  assert.equal(Object.hasOwn(created.payload, 'passwordHash'), false);

  const reset = await request(`/api/users/${created.payload.id}/password-reset`, { method: 'POST' });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.payload.name, '张三');
  assert.match(reset.payload.password, /^.{1,16}$/);

  const updated = await request(`/api/users/${created.payload.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ roles: ['产品', '研发'], status: '启用' })
  });
  assert.equal(updated.response.status, 200);
  assert.deepEqual(updated.payload.roles, ['产品', '研发']);
  assert.equal(updated.payload.role, '产品');

  const productIdentity = await request('/api/me', { headers: { 'X-BRMS-Demo-Role': 'product', 'X-BRMS-Demo-User-Id': created.payload.id } });
  assert.equal(productIdentity.response.status, 200);
  assert.equal(productIdentity.payload.id, created.payload.id);
  assert.equal(productIdentity.payload.role, 'product');
  assert.deepEqual(productIdentity.payload.roles, ['产品', '研发']);

  const screenerRequester = await request('/api/users/u2', {
    method: 'PATCH',
    body: JSON.stringify({ roles: ['业务需求质量管理员', '业务需求方'], status: '启用' })
  });
  assert.equal(screenerRequester.response.status, 200);
  const requesterIdentity = await request('/api/me', { headers: { 'X-BRMS-Demo-Role': 'screener', 'X-BRMS-Demo-User-Id': 'u2' } });
  assert.equal(requesterIdentity.payload.role, 'screener');
  assert.deepEqual(requesterIdentity.payload.roles, ['业务需求质量管理员', '业务需求方']);
  const project = (await request('/api/projects')).payload[0];
  const requirement = await request('/api/requirements', {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'screener', 'X-BRMS-Demo-User-Id': 'u2' },
    body: JSON.stringify({ title: '多角色质量管理员发起需求', source: '运营', projectId: project.id, descriptionHtml: '<p>由兼任业务需求方的质量管理员发起。</p>' })
  });
  assert.equal(requirement.response.status, 201);
  assert.equal(requirement.payload.requesterOwnerId, 'u2');
});

test('note updates create persistent workbench messages for the current workflow participants', async () => {
  const requesterHeaders = { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' };
  const screenerHeaders = { 'X-BRMS-Demo-Role': 'screener', 'X-BRMS-Demo-User-Id': 'u2' };
  const project = (await request('/api/projects')).payload.find((item) => item.name === '返现业务');
  const created = await request('/api/requirements', { method: 'POST', headers: requesterHeaders, body: JSON.stringify({ title: '备注消息通知验证', source: '运营', projectId: project.id, descriptionHtml: '<p>验证需求。</p>' }) });
  assert.equal(created.response.status, 201);

  const updated = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: requesterHeaders, body: JSON.stringify({ requesterNoteHtml: '<p>请优先关注转化链路。</p>', updatedAt: created.payload.updatedAt }) });
  assert.equal(updated.response.status, 200);
  const appended = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: requesterHeaders, body: JSON.stringify({ requesterNoteHtml: '<p>补充验收指标。</p>', updatedAt: updated.payload.updatedAt }) });
  assert.equal(appended.response.status, 200);
  assert.equal(appended.payload.requesterNotes.length, 2);
  assert.match(appended.payload.requesterNotes[0].contentHtml, /请优先关注转化链路/);
  assert.match(appended.payload.requesterNotes[1].contentHtml, /补充验收指标/);

  const inbox = await request('/api/messages', { headers: screenerHeaders });
  const message = inbox.payload.find((item) => item.requirementId === created.payload.id);
  assert.equal(inbox.response.status, 200);
  assert.ok(message);
  assert.equal(message.title, '需求补充说明已更新');
  assert.match(message.summary, /补充验收指标/);
  assert.equal(message.requirementCode, created.payload.code);

  const activities = await request('/api/requirement-activities', { headers: screenerHeaders });
  assert.equal(activities.response.status, 200);
  const activity = activities.payload.find((item) => item.requirementId === created.payload.id);
  assert.ok(activity);
  assert.equal(activity.statusTitle, '待评估需求');
  assert.equal(activity.count, 3);
  assert.equal(activity.requesterNoteUpdates, 2);
  assert.ok(Number.isFinite(Date.parse(activity.latestRequesterNote.at)));
  assert.equal(activity.workflowUpdates, 1);
  assert.equal(activity.latestWorkflowChange, '需求状态由 @王敏 从 - 变更为 待评估');
  assert.equal(activity.latestWorkflow.operator, '王敏');
  assert.equal(activity.latestWorkflow.from, '-');
  assert.equal(activity.latestWorkflow.to, '待评估');
  assert.ok(Number.isFinite(Date.parse(activity.latestWorkflow.at)));
  assert.equal(activity.engineeringNoteUpdates, 0);

  const markedRead = await request(`/api/requirement-activities/${created.payload.id}/read`, { method: 'POST', headers: screenerHeaders });
  assert.equal(markedRead.response.status, 200);
  assert.equal(markedRead.payload.requirementId, created.payload.id);
  assert.equal(markedRead.payload.readCount, 3);

  const clearedActivities = await request('/api/requirement-activities', { headers: screenerHeaders });
  assert.equal(clearedActivities.response.status, 200);
  assert.equal(clearedActivities.payload.some((item) => item.requirementId === created.payload.id), false);

  const afterReadUpdate = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: requesterHeaders, body: JSON.stringify({ requesterNoteHtml: '<p>验证全部已读。</p>', updatedAt: appended.payload.updatedAt }) });
  assert.equal(afterReadUpdate.response.status, 200);
  const markedAllRead = await request('/api/requirement-activities/read-all', { method: 'POST', headers: screenerHeaders });
  assert.equal(markedAllRead.response.status, 200);
  assert.ok(markedAllRead.payload.readCount >= 1);
  const allClearedActivities = await request('/api/requirement-activities', { headers: screenerHeaders });
  assert.equal(allClearedActivities.payload.some((item) => item.requirementId === created.payload.id), false);

  const requesterActivities = await request('/api/requirement-activities', { headers: requesterHeaders });
  assert.equal(requesterActivities.response.status, 200);
  assert.equal(requesterActivities.payload.some((item) => item.requirementId === created.payload.id), false);
});

test('requesters can append their own notes at every workflow stage without changing the requirement', async () => {
  const requesterHeaders = { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' };
  const foreignRequesterHeaders = { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' };
  const screenerHeaders = { 'X-BRMS-Demo-Role': 'screener', 'X-BRMS-Demo-User-Id': 'u2' };
  const project = (await request('/api/projects')).payload.find((item) => item.name === '返现业务');
  const created = await request('/api/requirements', { method: 'POST', headers: requesterHeaders, body: JSON.stringify({ title: '全流程需求方备注验证', source: '运营', projectId: project.id, descriptionHtml: '<p>验证备注不受阶段限制。</p>' }) });
  assert.equal(created.response.status, 201);

  const passed = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', headers: screenerHeaders, body: JSON.stringify({ action: 'pass', updatedAt: created.payload.updatedAt }) });
  const owner = (await request('/api/users')).payload.find((item) => item.role === '产品');
  const inProduction = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'pre', productOwnerId: owner.id, updatedAt: passed.payload.updatedAt }) });
  assert.equal(inProduction.payload.status, '待投产');

  const noted = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: requesterHeaders, body: JSON.stringify({ requesterNoteHtml: '<p>待投产阶段仍可补充需求方说明。</p>', updatedAt: inProduction.payload.updatedAt }) });
  assert.equal(noted.response.status, 200);
  assert.equal(noted.payload.status, '待投产');
  assert.equal(noted.payload.requesterNotes.at(-1).contentHtml, '<p>待投产阶段仍可补充需求方说明。</p>');

  const mixedUpdate = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: requesterHeaders, body: JSON.stringify({ title: '不应在待投产阶段编辑', requesterNoteHtml: '<p>不应混合保存。</p>', updatedAt: noted.payload.updatedAt }) });
  assert.equal(mixedUpdate.response.status, 403);
  assert.equal(mixedUpdate.payload.code, 'FORBIDDEN');

  const foreignNote = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: foreignRequesterHeaders, body: JSON.stringify({ requesterNoteHtml: '<p>他人不能代替需求方备注。</p>', updatedAt: noted.payload.updatedAt }) });
  assert.equal(foreignNote.response.status, 403);
  assert.equal(foreignNote.payload.code, 'FORBIDDEN');
});

test('administrators can create requirements and append every note type at any stage', async () => {
  const adminHeaders = { 'X-BRMS-Demo-Role': 'admin', 'X-BRMS-Demo-User-Id': 'u7' };
  const project = (await request('/api/projects')).payload.find((item) => item.name === '返现业务');
  const created = await request('/api/requirements', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ title: '管理员发起与备注验证', source: '运营', projectId: project.id, descriptionHtml: '<p>验证管理员全流程备注权限。</p>' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.requesterOwnerId, 'u7');

  const requesterNote = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ requesterNoteHtml: '<p>管理员添加需求方备注。</p>', updatedAt: created.payload.updatedAt }) });
  assert.equal(requesterNote.response.status, 200);
  const implementationNote = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ implementationNoteHtml: '<p>管理员添加实施补充。</p>', updatedAt: requesterNote.payload.updatedAt }) });
  assert.equal(implementationNote.response.status, 200);
  const engineeringNote = await request(`/api/requirements/${created.payload.id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ engineeringNoteHtml: '<p>管理员添加研发备注。</p>', updatedAt: implementationNote.payload.updatedAt }) });
  assert.equal(engineeringNote.response.status, 200);
  assert.equal(engineeringNote.payload.status, '待评估');
  assert.equal(engineeringNote.payload.requesterNotes.at(-1).contentHtml, '<p>管理员添加需求方备注。</p>');
  assert.equal(engineeringNote.payload.implementationNotes.at(-1).contentHtml, '<p>管理员添加实施补充。</p>');
  assert.equal(engineeringNote.payload.engineeringNotes.at(-1).contentHtml, '<p>管理员添加研发备注。</p>');
});

test('API persists requirement data and enforces workflow, references, and permissions', async () => {
  const projects = await request('/api/projects');
  const project = { response: projects.response, payload: projects.payload.find((item) => item.name === '返现业务') };
  assert.equal(project.response.status, 200);
  assert.ok(project.payload);

  const version = await request('/api/project-versions', { method: 'POST', body: JSON.stringify({ projectId: project.payload.id, version: '9.28.0', releaseDate: '2026-10-15' }) });
  assert.equal(version.response.status, 201);

  const requirement = await request('/api/requirements', { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' }, body: JSON.stringify({ title: '支持返现渠道能力', source: '运营', projectId: project.payload.id, descriptionHtml: '<p>需要支持新的返现渠道。</p>', solution: '已废弃字段不得被保存' }) });
  assert.equal(requirement.response.status, 201);
  assert.match(requirement.payload.code, /^FX-\d{3}$/);
  assert.equal(requirement.payload.descriptionHtml.includes('<script'), false);
  assert.equal(requirement.payload.source, '运营');
  assert.equal(requirement.payload.requesterOwnerId, 'u1');
  assert.equal(requirement.payload.requester, '王敏');
  assert.equal(Object.hasOwn(requirement.payload, 'solution'), false);

  const mismatchedRequester = await request('/api/requirements', { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' }, body: JSON.stringify({ title: '不可代替他人发起需求', source: '运营', projectId: project.payload.id, requesterOwnerId: 'u3', descriptionHtml: '<p>需求方必须与发起人一致。</p>' }) });
  assert.equal(mismatchedRequester.response.status, 403);
  assert.equal(mismatchedRequester.payload.code, 'FORBIDDEN');

  const creationWithOwner = await request('/api/requirements', { method: 'POST', body: JSON.stringify({ title: '业务需求方不可指定产品Owner', source: '运营', projectId: project.payload.id, descriptionHtml: '<p>产品Owner必须在预审通过后由业务系统管理员分配。</p>', productOwnerId: 'u4' }) });
  assert.equal(creationWithOwner.response.status, 403);
  assert.equal(creationWithOwner.payload.code, 'FORBIDDEN');

  const ownerPatch = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', body: JSON.stringify({ productOwnerId: 'u4', updatedAt: requirement.payload.updatedAt }) });
  assert.equal(ownerPatch.response.status, 403);
  assert.equal(ownerPatch.payload.code, 'FORBIDDEN');

  const requesterPatch = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', body: JSON.stringify({ requesterOwnerId: 'u3', updatedAt: requirement.payload.updatedAt }) });
  assert.equal(requesterPatch.response.status, 403);
  assert.equal(requesterPatch.payload.code, 'FORBIDDEN');

  const retiredSolutionUpdate = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', body: JSON.stringify({ solution: '更新也不得重新写入', updatedAt: requirement.payload.updatedAt }) });
  assert.equal(retiredSolutionUpdate.response.status, 200);
  assert.equal(Object.hasOwn(retiredSolutionUpdate.payload, 'solution'), false);

  const legacySource = await request('/api/requirements', { method: 'POST', body: JSON.stringify({ title: '旧需求来源应被拒绝', source: '技术需求', projectId: project.payload.id, descriptionHtml: '<p>旧枚举不再允许写入。</p>' }) });
  assert.equal(legacySource.response.status, 422);
  assert.equal(legacySource.payload.code, 'VALIDATION_ERROR');

  const forbidden = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'requester' }, body: JSON.stringify({ action: 'pass', updatedAt: retiredSolutionUpdate.payload.updatedAt }) });
  assert.equal(forbidden.response.status, 403);

  const productTerminateWhilePending = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'terminate', reason: '不应在待评估阶段终止', updatedAt: retiredSolutionUpdate.payload.updatedAt }) });
  assert.equal(productTerminateWhilePending.response.status, 403);
  assert.equal(productTerminateWhilePending.payload.code, 'FORBIDDEN');

  const engineerUpdateWhilePending = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'engineer' }, body: JSON.stringify({ implementationNoteHtml: '<p>不应在待评估阶段维护</p>', updatedAt: retiredSolutionUpdate.payload.updatedAt }) });
  assert.equal(engineerUpdateWhilePending.response.status, 403);
  assert.equal(engineerUpdateWhilePending.payload.code, 'FORBIDDEN');

  const pass = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'screener' }, body: JSON.stringify({ action: 'pass', updatedAt: retiredSolutionUpdate.payload.updatedAt }) });
  assert.equal(pass.payload.status, '待预审');

  const requesterEditBeforeProduction = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'requester' }, body: JSON.stringify({ title: '支持返现渠道能力（补充说明）', updatedAt: pass.payload.updatedAt }) });
  assert.equal(requesterEditBeforeProduction.response.status, 200);
  assert.equal(requesterEditBeforeProduction.payload.title, '支持返现渠道能力（补充说明）');

  const productOwner = await request('/api/users');
  const owner = productOwner.payload.find((item) => item.role === '产品');
  const productPre = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'pre', productOwnerId: owner.id, updatedAt: requesterEditBeforeProduction.payload.updatedAt }) });
  assert.equal(productPre.response.status, 403);
  assert.equal(productPre.payload.code, 'FORBIDDEN');

  const productPreReturn = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'preReturn', reason: '请补充验收范围', updatedAt: requesterEditBeforeProduction.payload.updatedAt }) });
  assert.equal(productPreReturn.response.status, 200);
  assert.equal(productPreReturn.payload.status, '待需求方重新评估');
  assert.equal(productPreReturn.payload.returnNotes[0].reason, '请补充验收范围');
  assert.equal(productPreReturn.payload.returnNotes[0].stage, '预审');
  assert.equal(productPreReturn.payload.history[0].operator, owner.name);

  const resubmittedAfterProductReturn = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'resubmit', updatedAt: productPreReturn.payload.updatedAt }) });
  assert.equal(resubmittedAfterProductReturn.payload.status, '待评估');

  const passedAgain = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'screener' }, body: JSON.stringify({ action: 'pass', updatedAt: resubmittedAfterProductReturn.payload.updatedAt }) });
  assert.equal(passedAgain.payload.status, '待预审');

  const productPreReviewSupplement = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ implementationNoteHtml: '<p>待预审阶段的产品补充说明</p>', updatedAt: passedAgain.payload.updatedAt }) });
  assert.equal(productPreReviewSupplement.response.status, 200);
  assert.equal(productPreReviewSupplement.payload.implementationNotes.length, 1);
  assert.equal(productPreReviewSupplement.payload.implementationNotes[0].contentHtml, '<p>待预审阶段的产品补充说明</p>');

  const engineerPreReviewSupplement = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'engineer' }, body: JSON.stringify({ implementationNoteHtml: '<p>研发不能维护产品补充说明</p>', updatedAt: productPreReviewSupplement.payload.updatedAt }) });
  assert.equal(engineerPreReviewSupplement.response.status, 403);
  assert.equal(engineerPreReviewSupplement.payload.code, 'FORBIDDEN');

  const missingOwner = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'pre', updatedAt: productPreReviewSupplement.payload.updatedAt }) });
  assert.equal(missingOwner.response.status, 422);
  assert.equal(missingOwner.payload.code, 'PRODUCT_OWNER_REQUIRED');

  const pre = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'pre', productOwnerId: owner.id, updatedAt: productPreReviewSupplement.payload.updatedAt }) });
  assert.equal(pre.payload.status, '待投产');
  assert.equal(pre.payload.productOwnerId, owner.id);
  assert.equal(pre.payload.productOwnerName, owner.name);
  assert.equal(pre.payload.currentHandler, owner.name);
  assert.equal(pre.payload.history[0].action, '预审通过并分配产品Owner');

  const productImplementation = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ implementationNoteHtml: '<p>产品补充实施范围</p>', updatedAt: pre.payload.updatedAt }) });
  assert.equal(productImplementation.response.status, 200);
  assert.equal(productImplementation.payload.implementationNotes.length, 2);
  assert.equal(productImplementation.payload.implementationNotes[1].contentHtml, '<p>产品补充实施范围</p>');

  const productEngineeringNote = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ engineeringNoteHtml: '<p>产品不可维护研发备注</p>', updatedAt: productImplementation.payload.updatedAt }) });
  assert.equal(productEngineeringNote.response.status, 403);
  assert.equal(productEngineeringNote.payload.code, 'FORBIDDEN');

  const engineerImplementation = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'engineer' }, body: JSON.stringify({ implementationNoteHtml: '<p>研发补充实施信息</p>', updatedAt: productImplementation.payload.updatedAt }) });
  assert.equal(engineerImplementation.response.status, 403);
  assert.equal(engineerImplementation.payload.code, 'FORBIDDEN');

  const engineerEngineeringNote = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'engineer' }, body: JSON.stringify({ engineeringNoteHtml: '<p>研发技术风险已记录</p>', updatedAt: productImplementation.payload.updatedAt }) });
  assert.equal(engineerEngineeringNote.response.status, 200);
  assert.equal(engineerEngineeringNote.payload.engineeringNotes.length, 1);
  assert.equal(engineerEngineeringNote.payload.engineeringNotes[0].contentHtml, '<p>研发技术风险已记录</p>');

  const terminated = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'terminate', reason: '停止当前方案', updatedAt: engineerEngineeringNote.payload.updatedAt }) });
  assert.equal(terminated.response.status, 200);
  assert.equal(terminated.payload.status, '需求终止');

  const terminatedImplementationNote = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ implementationNoteHtml: '<p>终止后的实施结论已补充。</p>', updatedAt: terminated.payload.updatedAt }) });
  assert.equal(terminatedImplementationNote.response.status, 200);
  assert.equal(terminatedImplementationNote.payload.status, '需求终止');
  assert.equal(terminatedImplementationNote.payload.implementationNotes.at(-1).contentHtml, '<p>终止后的实施结论已补充。</p>');

  const terminatedEngineeringNote = await request(`/api/requirements/${requirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'engineer' }, body: JSON.stringify({ engineeringNoteHtml: '<p>终止后的技术结论已补充。</p>', updatedAt: terminatedImplementationNote.payload.updatedAt }) });
  assert.equal(terminatedEngineeringNote.response.status, 200);
  assert.equal(terminatedEngineeringNote.payload.status, '需求终止');
  assert.equal(terminatedEngineeringNote.payload.engineeringNotes.at(-1).contentHtml, '<p>终止后的技术结论已补充。</p>');

  const designRequirement = await request('/api/requirements', { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' }, body: JSON.stringify({ title: '版本排期保护验证', source: '运营', projectId: project.payload.id, descriptionHtml: '<p>用于验证版本引用保护。</p>' }) });
  const designPassed = await request(`/api/requirements/${designRequirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'screener' }, body: JSON.stringify({ action: 'pass', updatedAt: designRequirement.payload.updatedAt }) });
  const designPre = await request(`/api/requirements/${designRequirement.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'pre', productOwnerId: owner.id, updatedAt: designPassed.payload.updatedAt }) });
  const design = await request(`/api/requirements/${designRequirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'startProductDesign', version: '9.28.0', updatedAt: designPre.payload.updatedAt }) });
  assert.equal(design.payload.status, '产品设计');
  assert.equal(design.payload.version, '9.28.0');

  const protectedVersion = await request(`/api/project-versions/${version.payload.id}`, { method: 'DELETE' });
  assert.equal(protectedVersion.response.status, 422);
  assert.equal(protectedVersion.payload.code, 'PROJECT_VERSION_REFERENCED');

  const protectedProject = await request(`/api/projects/${project.payload.id}`, { method: 'DELETE' });
  assert.equal(protectedProject.response.status, 422);
  assert.equal(protectedProject.payload.code, 'PROJECT_REFERENCED');

  const returnedRequirement = await request('/api/requirements', { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'requester' }, body: JSON.stringify({ title: '退回后可直接排期的需求', source: '产品', projectId: project.payload.id, descriptionHtml: '<p>会议已经达成共识，仅需补充文字说明。</p>' }) });
  const returned = await request(`/api/requirements/${returnedRequirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'screener' }, body: JSON.stringify({ action: 'return', reason: '请补充边界说明', updatedAt: returnedRequirement.payload.updatedAt }) });
  assert.equal(returned.payload.status, '待需求方重新评估');
  assert.equal(returned.payload.returnNotes[0].reason, '请补充边界说明');

  const updatedReturned = await request(`/api/requirements/${returnedRequirement.payload.id}`, { method: 'PATCH', headers: { 'X-BRMS-Demo-Role': 'requester' }, body: JSON.stringify({ title: '退回后已补充说明的需求', updatedAt: returned.payload.updatedAt }) });
  assert.equal(updatedReturned.response.status, 200);

  const resubmitted = await request(`/api/requirements/${returnedRequirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'requester' }, body: JSON.stringify({ action: 'resubmit', updatedAt: updatedReturned.payload.updatedAt }) });
  assert.equal(resubmitted.payload.status, '待评估');

  const returnedAgain = await request(`/api/requirements/${returnedRequirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'screener' }, body: JSON.stringify({ action: 'return', reason: '仍需补充验收范围', updatedAt: resubmitted.payload.updatedAt }) });
  assert.equal(returnedAgain.payload.status, '待需求方重新评估');

  const foreignResubmit = await request(`/api/requirements/${returnedRequirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' }, body: JSON.stringify({ action: 'resubmit', updatedAt: returnedAgain.payload.updatedAt }) });
  assert.equal(foreignResubmit.response.status, 403);
  assert.equal(foreignResubmit.payload.code, 'FORBIDDEN');

  const foreignRead = await request(`/api/requirements/${returnedRequirement.payload.id}`, { headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' } });
  assert.equal(foreignRead.response.status, 200);
  assert.equal(foreignRead.payload.id, returnedRequirement.payload.id);

  const direct = await request(`/api/requirements/${returnedRequirement.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'directToProduction', productOwnerId: owner.id, updatedAt: returnedAgain.payload.updatedAt }) });
  assert.equal(direct.payload.status, '待投产');
  assert.equal(direct.payload.productOwnerName, owner.name);
  assert.equal(direct.payload.history[0].action, '重新评估后预审通过并分配产品Owner');
});

test('API generates requirement codes from arbitrary Chinese project names', async () => {
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '会员增长业务', projectType: '导购电商', description: '' })
  });
  assert.equal(project.response.status, 201);

  const requirement = await request('/api/requirements', {
    method: 'POST',
    body: JSON.stringify({
      title: '会员权益优化',
      source: '产品',
      projectId: project.payload.id,
      descriptionHtml: '<p>优化会员权益展示与领取流程。</p>'
    })
  });
  assert.equal(requirement.response.status, 201);
  assert.equal(requirement.payload.code, 'HYZZ-001');
});

test('workbench exposes role-appropriate workflow stages and only returns requirements related to the current user or role', async () => {
  const workflowStatuses = ['待评估', '待需求方重新评估', '待预审', '待投产', '产品设计', '研发实施'];
  const projects = await request('/api/projects');
  const project = projects.payload.find((item) => item.name === '柚省业务');
  const created = await request('/api/requirements', {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' },
    body: JSON.stringify({ title: '待办关联范围验证', source: '运营', projectId: project.id, descriptionHtml: '<p>验证待办仅展示相关需求。</p>' })
  });
  const preReview = await request(`/api/requirements/${created.payload.id}/actions`, {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'screener' },
    body: JSON.stringify({ action: 'pass', updatedAt: created.payload.updatedAt })
  });
  assert.equal(preReview.payload.status, '待预审');

  for (const role of ['requester', 'screener', 'product', 'engineer', 'admin']) {
    const workbench = await request('/api/workbench', { headers: { 'X-BRMS-Demo-Role': role } });
    assert.equal(workbench.response.status, 200);
    const expected = role === 'screener'
      ? ['待评估', '被我退回的需求']
      : ['product', 'admin'].includes(role)
        ? [...workflowStatuses, '被我退回的需求']
        : workflowStatuses;
    assert.deepEqual(workbench.payload.cards.map((card) => card.status), expected);
    assert.ok(workbench.payload.items.length <= 5);
  }

  const screenerReturned = await request(`/api/workbench?status=${encodeURIComponent('待需求方重新评估')}`, { headers: { 'X-BRMS-Demo-Role': 'screener' } });
  assert.equal(screenerReturned.response.status, 404);
  assert.equal(screenerReturned.payload.code, 'NOT_FOUND');

  const requesterOwner = await request('/api/workbench?status=待预审', { headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' } });
  assert.equal(requesterOwner.response.status, 200);
  assert.ok(requesterOwner.payload.items.some((item) => item.id === created.payload.id));

  const productWorkbench = await request('/api/workbench?status=待预审', { headers: { 'X-BRMS-Demo-Role': 'product' } });
  assert.equal(productWorkbench.response.status, 200);
  assert.ok(productWorkbench.payload.items.some((item) => item.id === created.payload.id));

  const unrelatedRequester = await request('/api/workbench?status=待预审', { headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' } });
  assert.equal(unrelatedRequester.response.status, 200);
  assert.ok(unrelatedRequester.payload.cards.some((card) => card.status === '待预审'));
  assert.ok(unrelatedRequester.payload.items.every((item) => item.id !== created.payload.id));

  const unrelatedReturnedRequester = await request('/api/workbench?status=待需求方重新评估', { headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' } });
  assert.equal(unrelatedReturnedRequester.response.status, 200);
  assert.ok(unrelatedReturnedRequester.payload.items.every((item) => item.requesterOwnerId === 'u3'));

  const sharedDetail = await request(`/api/requirements/${created.payload.id}`, { headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' } });
  assert.equal(sharedDetail.response.status, 200);
  assert.equal(sharedDetail.payload.id, created.payload.id);

  const unknownCategory = await request(`/api/workbench?status=${encodeURIComponent('完成发布')}`, { headers: { 'X-BRMS-Demo-Role': 'requester' } });
  assert.equal(unknownCategory.response.status, 404);
  assert.equal(unknownCategory.payload.code, 'NOT_FOUND');
});

test('returned-by-me todo is scoped to the current return operator and active return state', async () => {
  const project = (await request('/api/projects')).payload.find((item) => item.name === '返现业务');
  const requesterHeaders = { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' };
  const created = await request('/api/requirements', {
    method: 'POST',
    headers: requesterHeaders,
    body: JSON.stringify({ title: '退回待办归属验证', source: '运营', projectId: project.id, descriptionHtml: '<p>验证退回人待办归属。</p>' })
  });
  const returned = await request(`/api/requirements/${created.payload.id}/actions`, {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'screener' },
    body: JSON.stringify({ action: 'return', reason: '请补充验收范围', updatedAt: created.payload.updatedAt })
  });
  assert.equal(returned.payload.status, '待需求方重新评估');

  const screenerWorkbench = await request(`/api/workbench?status=${encodeURIComponent('被我退回的需求')}`, { headers: { 'X-BRMS-Demo-Role': 'screener' } });
  assert.equal(screenerWorkbench.response.status, 200);
  assert.ok(screenerWorkbench.payload.items.some((item) => item.id === created.payload.id));

  const productWorkbench = await request(`/api/workbench?status=${encodeURIComponent('被我退回的需求')}`, { headers: { 'X-BRMS-Demo-Role': 'product' } });
  assert.equal(productWorkbench.response.status, 200);
  assert.ok(productWorkbench.payload.items.every((item) => item.id !== created.payload.id));

  const returnedByScreener = await request('/api/requirements?returnedByMe=true', { headers: { 'X-BRMS-Demo-Role': 'screener' } });
  assert.ok(returnedByScreener.payload.some((item) => item.id === created.payload.id));
  const returnedByProduct = await request('/api/requirements?returnedByMe=true', { headers: { 'X-BRMS-Demo-Role': 'product' } });
  assert.ok(returnedByProduct.payload.every((item) => item.id !== created.payload.id));

  const resubmitted = await request(`/api/requirements/${created.payload.id}/actions`, {
    method: 'POST', headers: requesterHeaders, body: JSON.stringify({ action: 'resubmit', updatedAt: returned.payload.updatedAt })
  });
  assert.equal(resubmitted.payload.status, '待评估');
  const afterResubmit = await request('/api/requirements?returnedByMe=true', { headers: { 'X-BRMS-Demo-Role': 'screener' } });
  assert.ok(afterResubmit.payload.every((item) => item.id !== created.payload.id));
});

test('engineer workbench only treats engineering implementation as a role todo', async () => {
  const projects = await request('/api/projects');
  const project = projects.payload.find((item) => item.name === '柚省业务');
  const owner = (await request('/api/users')).payload.find((item) => item.role === '产品');
  const created = await request('/api/requirements', {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' },
    body: JSON.stringify({ title: '研发待办节点归属验证', source: '运营', projectId: project.id, descriptionHtml: '<p>研发仅在研发实施节点获得角色待办。</p>' })
  });
  const screened = await request(`/api/requirements/${created.payload.id}/actions`, {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'screener' },
    body: JSON.stringify({ action: 'pass', updatedAt: created.payload.updatedAt })
  });
  const scheduled = await request(`/api/requirements/${created.payload.id}/actions`, {
    method: 'POST',
    body: JSON.stringify({ action: 'pre', productOwnerId: owner.id, updatedAt: screened.payload.updatedAt })
  });

  const productionWorkbench = await request('/api/workbench?status=待投产', { headers: { 'X-BRMS-Demo-Role': 'engineer' } });
  assert.equal(productionWorkbench.response.status, 200);
  assert.ok(productionWorkbench.payload.items.every((item) => item.id !== created.payload.id));

  const version = await request('/api/project-versions', { method: 'POST', body: JSON.stringify({ projectId: project.id, version: '9.29.0', releaseDate: '2026-11-01' }) });
  const designed = await request(`/api/requirements/${created.payload.id}/actions`, {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'product' },
    body: JSON.stringify({ action: 'startProductDesign', version: version.payload.version, updatedAt: scheduled.payload.updatedAt })
  });

  const designWorkbench = await request('/api/workbench?status=产品设计', { headers: { 'X-BRMS-Demo-Role': 'engineer' } });
  assert.equal(designWorkbench.response.status, 200);
  assert.ok(designWorkbench.payload.items.every((item) => item.id !== created.payload.id));

  const implemented = await request(`/api/requirements/${created.payload.id}/actions`, {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'product' },
    body: JSON.stringify({ action: 'startEngineering', updatedAt: designed.payload.updatedAt })
  });
  assert.equal(implemented.payload.status, '研发实施');

  const engineeringWorkbench = await request('/api/workbench?status=研发实施', { headers: { 'X-BRMS-Demo-Role': 'engineer' } });
  assert.equal(engineeringWorkbench.response.status, 200);
  assert.ok(engineeringWorkbench.payload.items.some((item) => item.id === created.payload.id));
});

test('requirement filtering and archive grouping are evaluated by the server', async () => {
  const projects = await request('/api/projects');
  const project = projects.payload.find((item) => item.name === '柚省业务');
  const created = await request('/api/requirements', {
    method: 'POST',
    body: JSON.stringify({ title: '历史归档验证需求', source: '研发', projectId: project.id, descriptionHtml: '<p>用于验证服务端归档规则。</p>' })
  });
  const passed = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'screener' }, body: JSON.stringify({ action: 'pass', updatedAt: created.payload.updatedAt }) });
  const owner = (await request('/api/users')).payload.find((item) => item.role === '产品');
  const scheduled = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'pre', productOwnerId: owner.id, updatedAt: passed.payload.updatedAt }) });
  const oldVersion = await request('/api/project-versions', { method: 'POST', body: JSON.stringify({ projectId: project.id, version: '1.0.0', releaseDate: '2025-01-01' }) });
  const designed = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'startProductDesign', version: oldVersion.payload.version, updatedAt: scheduled.payload.updatedAt }) });
  const implemented = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'startEngineering', updatedAt: designed.payload.updatedAt }) });
  const released = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'release', releaseDate: '2025-01-15', updatedAt: implemented.payload.updatedAt }) });
  assert.equal(released.payload.status, '完成发布');

  const filtered = await request(`/api/requirements?keyword=${encodeURIComponent('历史归档')}&source=研发&sortBy=createdAt&sortOrder=asc`);
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.payload.length, 1);
  assert.equal(filtered.payload[0].id, created.payload.id);

  const multiFiltered = await request(`/api/requirements?projectId=${project.id}&projectId=not-a-project&status=完成发布&status=待评估&source=研发&source=运营`);
  assert.equal(multiFiltered.response.status, 200);
  assert.ok(multiFiltered.payload.some((item) => item.id === created.payload.id));
  assert.ok(multiFiltered.payload.every((item) => item.projectId === project.id));
  assert.ok(multiFiltered.payload.every((item) => ['完成发布', '待评估'].includes(item.status)));
  assert.ok(multiFiltered.payload.every((item) => ['研发', '运营'].includes(item.source)));

  const archives = await request('/api/archives?keyword=历史归档');
  assert.equal(archives.response.status, 200);
  assert.equal(archives.payload.total, 1);
  assert.equal(archives.payload.groupCount, 1);
  assert.equal(archives.payload.items[0].projectName, '柚省业务');
  assert.equal(archives.payload.items[0].version, '1.0.0');
});

test('completed requirements can be manually archived immediately with audit and permission checks', async () => {
  const projects = await request('/api/projects');
  const project = projects.payload.find((item) => item.name === '返现业务');
  const requirement = await request('/api/requirements', {
    method: 'POST',
    body: JSON.stringify({ title: '手动归档验证需求', source: '运营', projectId: project.id, descriptionHtml: '<p>用于验证完成发布后的手动归档。</p>' })
  });
  const passed = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'screener' }, body: JSON.stringify({ action: 'pass', updatedAt: requirement.payload.updatedAt }) });
  const owner = (await request('/api/users')).payload.find((item) => item.role === '产品');
  const pre = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'pre', productOwnerId: owner.id, updatedAt: passed.payload.updatedAt }) });
  const version = await request('/api/project-versions', { method: 'POST', body: JSON.stringify({ projectId: project.id, version: 'manual-archive-1.0', releaseDate: '2026-10-01' }) });
  const designed = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'startProductDesign', version: version.payload.version, updatedAt: pre.payload.updatedAt }) });
  const implemented = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'startEngineering', updatedAt: designed.payload.updatedAt }) });
  const released = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'release', releaseDate: '2026-09-25', updatedAt: implemented.payload.updatedAt }) });
  assert.equal(released.payload.status, '完成发布');

  const beforeArchive = await request(`/api/archives?keyword=${encodeURIComponent('手动归档验证')}`);
  assert.equal(beforeArchive.payload.total, 0);

  const forbidden = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'requester' }, body: JSON.stringify({ action: 'archive', updatedAt: released.payload.updatedAt }) });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.payload.code, 'FORBIDDEN');

  const archived = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'archive', updatedAt: released.payload.updatedAt }) });
  assert.equal(archived.response.status, 200);
  assert.equal(archived.payload.status, '完成发布');
  assert.ok(archived.payload.archivedAt);
  assert.equal(archived.payload.history[0].action, '需求归档');
  assert.equal(archived.payload.history[0].note, '手动归档');

  const archiveList = await request(`/api/archives?keyword=${encodeURIComponent('手动归档验证')}`);
  assert.equal(archiveList.payload.total, 1);
  assert.equal(archiveList.payload.items[0].requirements[0].id, requirement.payload.id);

  const archiveForAnotherRequester = await request(`/api/archives?keyword=${encodeURIComponent('手动归档验证')}`, { headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' } });
  assert.equal(archiveForAnotherRequester.response.status, 200);
  assert.equal(archiveForAnotherRequester.payload.total, 1);
  const archivedDetailForAnotherRequester = await request(`/api/requirements/${requirement.payload.id}`, { headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u3' } });
  assert.equal(archivedDetailForAnotherRequester.response.status, 200);
  assert.equal(archivedDetailForAnotherRequester.payload.id, requirement.payload.id);

  const duplicate = await request(`/api/requirements/${requirement.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'archive', updatedAt: archived.payload.updatedAt }) });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.payload.code, 'STATE_CONFLICT');
});

test('quick release atomically publishes selected implemented requirements for one project version', async () => {
  const project = (await request('/api/projects')).payload.find((item) => item.name === '返现业务');
  const owner = (await request('/api/users')).payload.find((item) => item.role === '产品');
  const version = await request('/api/project-versions', { method: 'POST', body: JSON.stringify({ projectId: project.id, version: 'quick-release-1.0', releaseDate: '2026-12-18' }) });
  const otherVersion = await request('/api/project-versions', { method: 'POST', body: JSON.stringify({ projectId: project.id, version: 'quick-release-2.0', releaseDate: '2026-12-25' }) });
  assert.equal(version.response.status, 201);
  assert.equal(otherVersion.response.status, 201);

  const makeImplemented = async (title, versionName) => {
    const created = await request('/api/requirements', {
      method: 'POST',
      headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' },
      body: JSON.stringify({ title, source: '运营', projectId: project.id, descriptionHtml: '<p>用于验证批量快速发布。</p>' })
    });
    const passed = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'screener' }, body: JSON.stringify({ action: 'pass', updatedAt: created.payload.updatedAt }) });
    const pre = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'pre', productOwnerId: owner.id, updatedAt: passed.payload.updatedAt }) });
    const designed = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'startProductDesign', version: versionName, updatedAt: pre.payload.updatedAt }) });
    const implemented = await request(`/api/requirements/${created.payload.id}/actions`, { method: 'POST', headers: { 'X-BRMS-Demo-Role': 'product' }, body: JSON.stringify({ action: 'startEngineering', updatedAt: designed.payload.updatedAt }) });
    assert.equal(implemented.response.status, 200);
    assert.equal(implemented.payload.status, '研发实施');
    return implemented.payload;
  };

  const first = await makeImplemented('快速发布需求一', version.payload.version);
  const second = await makeImplemented('快速发布需求二', version.payload.version);
  const mismatched = await makeImplemented('快速发布其他版本需求', otherVersion.payload.version);

  const denied = await request('/api/requirements/quick-release', {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'requester', 'X-BRMS-Demo-User-Id': 'u1' },
    body: JSON.stringify({ projectVersionId: version.payload.id, requirementIds: [first.id] })
  });
  assert.equal(denied.response.status, 403);

  const atomicFailure = await request('/api/requirements/quick-release', {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'product' },
    body: JSON.stringify({ projectVersionId: version.payload.id, requirementIds: [first.id, mismatched.id] })
  });
  assert.equal(atomicFailure.response.status, 422);
  assert.equal((await request(`/api/requirements/${first.id}`)).payload.status, '研发实施');
  assert.equal((await request(`/api/requirements/${mismatched.id}`)).payload.status, '研发实施');

  const published = await request('/api/requirements/quick-release', {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'product' },
    body: JSON.stringify({ projectVersionId: version.payload.id, requirementIds: [first.id, second.id] })
  });
  assert.equal(published.response.status, 200);
  assert.equal(published.payload.count, 2);
  assert.equal(published.payload.version.id, version.payload.id);
  published.payload.requirements.forEach((item) => {
    assert.equal(item.status, '完成发布');
    assert.equal(item.releaseDate, version.payload.releaseDate);
    assert.equal(item.currentHandler, '-');
    assert.equal(item.history[0].action, '快速发布');
    assert.match(item.history[0].note, /quick-release-1\.0/);
  });

  const empty = await request('/api/requirements/quick-release', {
    method: 'POST',
    headers: { 'X-BRMS-Demo-Role': 'product' },
    body: JSON.stringify({ projectVersionId: version.payload.id, requirementIds: [] })
  });
  assert.equal(empty.response.status, 422);
  assert.equal(empty.payload.code, 'VALIDATION_ERROR');
});

test('session login gates business APIs, supports password changes, logout, and lockout', async () => {
  const authPort = port + 1;
  const authDatabasePath = path.join(os.tmpdir(), `brms-auth-test-${process.pid}.sqlite`);
  const authUploadPath = path.join(os.tmpdir(), `brms-auth-test-uploads-${process.pid}`);
  fs.rmSync(authDatabasePath, { force: true });
  fs.rmSync(authUploadPath, { recursive: true, force: true });
  const authServer = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, BRMS_API_PORT: String(authPort), BRMS_DB_PATH: authDatabasePath, BRMS_UPLOAD_DIR: authUploadPath },
    stdio: 'ignore'
  });
  const authRequest = async (pathname, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${authPort}${pathname}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    return { response, payload: response.status === 204 ? null : await response.json() };
  };
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${authPort}/api/health`)).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (attempt === 39) throw new Error('Authentication API did not become ready');
    }
    const denied = await authRequest('/api/me');
    assert.equal(denied.response.status, 401);
    assert.equal(denied.payload.code, 'UNAUTHENTICATED');

    const login = await authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ name: '王敏', password: 'BRMS@2026' }) });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^brms_session=/);
    assert.equal((await authRequest('/api/me', { headers: { Cookie: cookie } })).response.status, 200);

    const changed = await authRequest('/api/auth/change-password', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ currentPassword: 'BRMS@2026', newPassword: 'Changed@2026' }) });
    assert.equal(changed.response.status, 200);
    const changedCookie = changed.response.headers.get('set-cookie').split(';')[0];
    assert.equal((await authRequest('/api/me', { headers: { Cookie: cookie } })).response.status, 401);
    assert.equal((await authRequest('/api/me', { headers: { Cookie: changedCookie } })).response.status, 200);
    assert.equal((await authRequest('/api/auth/logout', { method: 'POST', headers: { Cookie: changedCookie } })).response.status, 204);
    assert.equal((await authRequest('/api/me', { headers: { Cookie: changedCookie } })).response.status, 401);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal((await authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ name: '赵宁', password: 'wrong-password' }) })).response.status, 401);
    }
    const locked = await authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ name: '赵宁', password: 'wrong-password' }) });
    assert.equal(locked.response.status, 429);
    assert.equal(locked.payload.message, '请联系系统管理员重置密码，或5分钟后再次尝试。');
  } finally {
    authServer.kill();
    fs.rmSync(authDatabasePath, { force: true });
    fs.rmSync(authUploadPath, { recursive: true, force: true });
  }
});
