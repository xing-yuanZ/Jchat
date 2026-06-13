// Supabase 配置
const SUPABASE_URL = 'https://cxilodvbdhtxtrldoswl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_36lHK24HL6drOmuhSTTv8g_w2n0fU5H';
const _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const EMAIL_SUFFIX = '@jchat.local';
const STORAGE_BUCKET = 'chat_files';

// 全局状态
let currentUser = null;
let currentProfile = null;
let currentChatUser = null;
let messagesSubscription = null;
let unreadCounts = new Map();

// ========== 辅助函数 ==========
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}
function getInitial(name) {
    return name ? name.charAt(0).toUpperCase() : '?';
}

// 渲染消息内容（文本、图片、视频）
function renderMessageContent(content) {
    if (!content) return '';
    const urlRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|mp4|webm|mov))/gi;
    let lastIndex = 0;
    const parts = [];
    let match;
    while ((match = urlRegex.exec(content)) !== null) {
        if (match.index > lastIndex) parts.push({ type: 'text', text: content.substring(lastIndex, match.index) });
        const url = match[0];
        const ext = match[2].toLowerCase();
        const isImage = ['jpg','jpeg','png','gif'].includes(ext);
        const isVideo = ['mp4','webm','mov'].includes(ext);
        parts.push({ type: isImage ? 'image' : (isVideo ? 'video' : 'file'), url: url });
        lastIndex = match.index + url.length;
    }
    if (lastIndex < content.length) parts.push({ type: 'text', text: content.substring(lastIndex) });
    if (parts.length === 0) return `<div class="message-content">${escapeHtml(content)}</div>`;
    let html = '<div class="message-content">';
    for (const part of parts) {
        if (part.type === 'text') html += escapeHtml(part.text);
        else if (part.type === 'image') html += `<img src="${escapeHtml(part.url)}" class="message-media" onclick="window.open('${escapeHtml(part.url)}', '_blank')" style="max-width:200px; max-height:200px; border-radius:12px; cursor:pointer;">`;
        else if (part.type === 'video') html += `<video controls class="message-media" style="max-width:200px; max-height:200px; border-radius:12px;" src="${escapeHtml(part.url)}"></video>`;
        else html += `<a href="${escapeHtml(part.url)}" target="_blank">📎 查看文件</a>`;
    }
    html += '</div>';
    return html;
}

function renderMessage(m) {
    const isSent = (m.from_user_id === currentUser.id);
    const timeStr = new Date(m.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const contentHtml = renderMessageContent(m.content);
    return `<div class="message ${isSent ? 'sent' : 'received'}" data-message-id="${m.id}" data-message-content="${escapeHtml(m.content)}">
                <div class="bubble">${contentHtml}</div>
                <div class="message-time">${timeStr}</div>
            </div>`;
}

async function uploadFile(file) {
    if (!file) return null;
    const fileExt = file.name.split('.').pop();
    const fileName = `${currentUser.id}/${Date.now()}_${Math.random().toString(36).substring(2,8)}.${fileExt}`;
    const { data, error } = await _supabase.storage.from(STORAGE_BUCKET).upload(fileName, file);
    if (error) { alert('上传失败: ' + error.message); return null; }
    const { data: { publicUrl } } = _supabase.storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
    return publicUrl;
}

async function sendMessageWithFile(file) {
    if (!currentChatUser) return;
    const inputEl = document.getElementById('chat-input');
    let content = inputEl ? inputEl.value.trim() : '';
    if (file) {
        const url = await uploadFile(file);
        if (url) content = content ? content + ' ' + url : url;
        else return;
    }
    if (!content) return;
    if (currentProfile.is_muted) { alert('你已被禁言'); return; }
    const { error } = await _supabase.from('messages').insert({
        from_user_id: currentUser.id,
        to_user_id: currentChatUser.id,
        content: content
    });
    if (error) alert('发送失败: ' + error.message);
    else if (inputEl) inputEl.value = '';
}

// ========== 数据库操作 ==========
async function loadUnreadCounts() {
    const { data, error } = await _supabase.from('unread_messages').select('from_user_id, count').eq('user_id', currentUser.id);
    if (!error && data) {
        unreadCounts.clear();
        data.forEach(item => unreadCounts.set(item.from_user_id, item.count));
    }
}
async function clearUnreadForUser(fromUserId) {
    await _supabase.rpc('clear_unread_count', { p_from_user_id: fromUserId });
    unreadCounts.set(fromUserId, 0);
}
async function ensureProfile(user, username) {
    await _supabase.from('public_profiles').upsert({
        id: user.id, email: user.email, display_name: username,
        is_admin: false, is_muted: false, bio: '', deleted_at: null
    }, { onConflict: 'id', ignoreDuplicates: true });
}
async function fetchCurrentProfile() {
    for (let i = 0; i < 10; i++) {
        const { data, error } = await _supabase.from('public_profiles').select('*').eq('id', currentUser.id).maybeSingle();
        if (data) return data;
        if (i === 0) { const username = currentUser.email ? currentUser.email.replace(EMAIL_SUFFIX, '') : 'user'; await ensureProfile(currentUser, username); }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('无法获取用户资料');
}

async function getFriendsList() {
    const { data: friendships } = await _supabase.from('friendships').select('user_id, friend_id').or(`user_id.eq.${currentUser.id},friend_id.eq.${currentUser.id}`).eq('status', 'accepted');
    const friendIds = [];
    if (friendships) friendships.forEach(f => { if (f.user_id === currentUser.id) friendIds.push(f.friend_id); else friendIds.push(f.user_id); });
    if (friendIds.length === 0) return [];
    const { data: friends } = await _supabase.from('public_profiles').select('id, display_name').in('id', friendIds).is('deleted_at', null);
    if (!friends) return [];
    const list = [];
    for (const f of friends) {
        const { data: msgData } = await _supabase.from('messages').select('content, created_at').or(`and(from_user_id.eq.${currentUser.id},to_user_id.eq.${f.id}),and(from_user_id.eq.${f.id},to_user_id.eq.${currentUser.id})`).order('created_at', { ascending: false }).limit(1);
        const lastMsg = (msgData && msgData[0]) ? msgData[0] : null;
        const lastContent = lastMsg ? (lastMsg.content.length > 30 ? lastMsg.content.substring(0,30)+'...' : lastMsg.content) : '';
        const lastTime = lastMsg ? new Date(lastMsg.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
        const unread = unreadCounts.get(f.id) || 0;
        list.push({ id: f.id, name: f.display_name, lastContent, lastTime, unread, lastTimestamp: lastMsg ? new Date(lastMsg.created_at).getTime() : 0 });
    }
    list.sort((a,b) => b.lastTimestamp - a.lastTimestamp);
    return list;
}

// ========== 渲染好友列表页 ==========
async function renderFriendsList() {
    const list = await getFriendsList();
    let html = `<div class="friends-header"><div class="title">JChat</div><div class="user-info" id="user-menu-trigger"><div class="user-avatar">${getInitial(currentProfile.display_name)}</div><div class="user-name">${escapeHtml(currentProfile.display_name)}</div><div>▼</div></div></div>`;
    if (list.length === 0) html += '<div style="padding:40px;text-align:center;color:#888;">暂无好友，去通讯录添加吧</div>';
    else {
        html += '<div class="friends-list">';
        for (const item of list) {
            const badge = item.unread > 0 ? `<span class="unread-badge">${item.unread > 99 ? '99+' : item.unread}</span>` : '';
            html += `<div class="friend-item" data-id="${item.id}" data-name="${escapeHtml(item.name)}"><div class="avatar">${getInitial(item.name)}${badge}</div><div class="friend-info"><div class="friend-name">${escapeHtml(item.name)}</div><div class="last-message">${escapeHtml(item.lastContent)}</div></div><div class="last-time">${item.lastTime}</div></div>`;
        }
        html += '</div>';
    }
    return html;
}

// ========== 渲染聊天页 ==========
async function renderChatWindow() {
    if (!currentChatUser) return '<div style="padding:40px;text-align:center;">请选择好友</div>';
    const { data: messages } = await _supabase.from('messages').select('*').or(`and(from_user_id.eq.${currentUser.id},to_user_id.eq.${currentChatUser.id}),and(from_user_id.eq.${currentChatUser.id},to_user_id.eq.${currentUser.id})`).order('created_at', { ascending: true });
    let msgsHtml = '';
    if (messages && messages.length) { for (const m of messages) msgsHtml += renderMessage(m); }
    else msgsHtml = '<div style="text-align:center;color:#888;padding:20px;">暂无消息</div>';
    return `<div class="chat-header"><div class="back-btn" id="chat-back-btn">←</div><div class="chat-title">${escapeHtml(currentChatUser.display_name)}</div><div class="more-btn" id="chat-more-btn">···</div></div><div class="chat-messages" id="chat-messages">${msgsHtml}</div><div class="chat-input-area"><button class="emoji-btn" id="emoji-btn">😀</button><button class="file-btn" id="file-btn">📎</button><div class="input-wrapper"><input type="text" id="chat-input" placeholder="输入消息"></div><button class="send-btn" id="chat-send">发送</button><div class="emoji-picker" id="emoji-picker">${['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','💩','👻','💀','👽','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾'].map(e => `<span class="emoji-item">${e}</span>`).join('')}</div><input type="file" id="file-input" style="display:none" accept="image/*,video/*"></div>`;
}

// ========== 消息操作 ==========
async function deleteMessage(messageId) {
    const { error } = await _supabase.from('messages').delete().eq('id', messageId);
    if (error) alert('删除失败: ' + error.message);
    else await refreshChatWindow();
}
async function clearChatHistory() {
    if (!confirm('确定清空与 ' + currentChatUser.display_name + ' 的聊天记录吗？')) return;
    const { error } = await _supabase.from('messages').delete().or(`and(from_user_id.eq.${currentUser.id},to_user_id.eq.${currentChatUser.id}),and(from_user_id.eq.${currentChatUser.id},to_user_id.eq.${currentUser.id})`);
    if (error) alert('清空失败: ' + error.message);
    else { await refreshChatWindow(); await showFriendsView(); }
}
async function refreshChatWindow() {
    if (!currentChatUser) return;
    const chatContent = await renderChatWindow();
    const chatContentDiv = document.getElementById('chat-content');
    if (chatContentDiv) chatContentDiv.innerHTML = chatContent;
    attachChatEvents();
}

// ========== 页面切换 ==========
function showActionMenu() {
    let menuHtml = '<div class="action-menu" id="action-menu"><div class="menu-item" data-action="profile">我的主页</div><div class="menu-item" data-action="settings">设置</div>';
    if (currentProfile.is_admin) menuHtml += '<div class="menu-item" data-action="admin">管理面板</div>';
    menuHtml += '<div class="menu-item" data-action="logout">退出登录</div></div><div class="menu-overlay" id="menu-overlay"></div>';
    document.body.insertAdjacentHTML('beforeend', menuHtml);
    const menu = document.getElementById('action-menu');
    const overlay = document.getElementById('menu-overlay');
    overlay.classList.add('show');
    setTimeout(() => menu.classList.add('show'), 10);
    const close = () => { menu.classList.remove('show'); overlay.classList.remove('show'); setTimeout(() => { if (menu) menu.remove(); if (overlay) overlay.remove(); }, 300); };
    overlay.onclick = close;
    document.querySelectorAll('.action-menu .menu-item').forEach(el => {
        el.onclick = async () => {
            const action = el.dataset.action;
            close();
            if (action === 'profile') await showProfilePage();
            else if (action === 'settings') await showSettingsPage();
            else if (action === 'admin') await showAdminPage();
            else if (action === 'logout') { await _supabase.auth.signOut(); location.reload(); }
        };
    });
}

async function showFriendsView() {
    const friendsContent = await renderFriendsList();
    document.getElementById('friends-content').innerHTML = friendsContent;
    document.getElementById('app').classList.remove('show-chat');
    attachFriendsEvents();
}
async function showChatView(chatUser) {
    if (chatUser) currentChatUser = chatUser;
    const chatContent = await renderChatWindow();
    document.getElementById('chat-content').innerHTML = chatContent;
    document.getElementById('app').classList.add('show-chat');
    attachChatEvents();
    if (unreadCounts.get(currentChatUser.id) > 0) {
        await clearUnreadForUser(currentChatUser.id);
        await loadUnreadCounts();
        await showFriendsView();
    }
}

// ========== 其他页面（个人主页、设置、管理） ==========
async function showProfilePage() {
    const html = `<div class="page"><div class="card"><div style="display:flex; gap:16px; align-items:center;"><div class="avatar" style="width:64px; height:64px; font-size:28px;">${getInitial(currentProfile.display_name)}</div><div><div style="font-size:20px; font-weight:600;">${escapeHtml(currentProfile.display_name)}</div><div>${currentProfile.is_admin ? '管理员' : '普通用户'}</div>${currentProfile.is_muted ? '<div style="color:red;">⛔ 禁言中</div>' : ''}</div></div><div><strong>简介</strong><br>${escapeHtml(currentProfile.bio || '这个人很懒')}</div><div><strong>加入时间</strong><br>${new Date(currentProfile.created_at).toLocaleDateString()}</div></div><button onclick="location.reload()">返回</button></div>`;
    document.getElementById('root').innerHTML = html;
}
async function showSettingsPage() {
    const html = `<div class="page"><div class="card"><h3>更改昵称</h3><input id="new-name" value="${escapeHtml(currentProfile.display_name)}"><button id="update-name">保存</button></div><div class="card"><h3>修改密码</h3><input type="password" id="old-pwd" placeholder="当前密码"><input type="password" id="new-pwd" placeholder="新密码"><button id="update-pwd">更新密码</button></div><div class="card"><h3>个人简介</h3><textarea id="bio-text" rows="2">${escapeHtml(currentProfile.bio || '')}</textarea><button id="update-bio">保存简介</button></div><div class="card"><h3>上传头像</h3><input type="file" id="avatar-file" accept="image/*"><button id="upload-avatar">上传</button></div><div class="card"><h3>危险区域</h3><button id="delete-account" class="danger-btn">永久删除账户</button></div><button onclick="location.reload()">返回</button></div>`;
    document.getElementById('root').innerHTML = html;
    document.getElementById('update-name')?.addEventListener('click', async () => {
        const newName = document.getElementById('new-name').value.trim();
        if (!newName) return;
        await _supabase.from('public_profiles').update({ display_name: newName }).eq('id', currentUser.id);
        currentProfile.display_name = newName;
        alert('昵称已更新');
        location.reload();
    });
    document.getElementById('update-pwd')?.addEventListener('click', async () => {
        const old = document.getElementById('old-pwd').value;
        const newPwd = document.getElementById('new-pwd').value;
        if (!old || !newPwd) return;
        const { error } = await _supabase.auth.updateUser({ password: newPwd });
        if (error) alert(error.message);
        else { alert('密码已修改，请重新登录'); await _supabase.auth.signOut(); location.reload(); }
    });
    document.getElementById('update-bio')?.addEventListener('click', async () => {
        const bio = document.getElementById('bio-text').value;
        await _supabase.from('public_profiles').update({ bio }).eq('id', currentUser.id);
        currentProfile.bio = bio;
        alert('简介已更新');
        location.reload();
    });
    document.getElementById('upload-avatar')?.addEventListener('click', async () => {
        const file = document.getElementById('avatar-file').files[0];
        if (!file) return;
        const ext = file.name.split('.').pop();
        const path = `${currentUser.id}/${Date.now()}.${ext}`;
        const { error: upErr } = await _supabase.storage.from('avatars').upload(path, file);
        if (upErr) { alert(upErr.message); return; }
        const { data: { publicUrl } } = _supabase.storage.from('avatars').getPublicUrl(path);
        await _supabase.from('public_profiles').update({ avatar_url: publicUrl }).eq('id', currentUser.id);
        currentProfile.avatar_url = publicUrl;
        alert('头像已更新');
        location.reload();
    });
    document.getElementById('delete-account')?.addEventListener('click', async () => {
        if (!confirm('永久删除所有数据？不可恢复！')) return;
        await _supabase.from('public_profiles').update({ deleted_at: new Date().toISOString() }).eq('id', currentUser.id);
        await _supabase.auth.signOut();
        location.reload();
    });
}
async function showAdminPage() {
    const { data: users } = await _supabase.from('public_profiles').select('*').is('deleted_at', null);
    const { data: ann } = await _supabase.from('announcements').select('content').order('created_at', { ascending: false }).limit(1);
    const currentAnn = (ann && ann[0] && ann[0].content) || '';
    let tableRows = '';
    for (const u of users) {
        const isSelf = (u.id === currentUser.id);
        tableRows += `<tr><td class="checkbox-col"><input type="checkbox" class="user-checkbox" value="${u.id}"><\/td><td>${escapeHtml(u.display_name)}<\/td><td>${u.is_admin ? '是' : `<button class="set-admin" data-id="${u.id}">设为管理员</button>`}<\/td><td>${u.is_muted ? '已禁言' : `<button class="toggle-mute" data-id="${u.id}">禁言</button>`}<\/td><td>${isSelf ? '自己' : `<button class="admin-del" data-id="${u.id}">删除</button>`}<\/td><\/tr>`;
    }
    const html = `<div class="page"><div class="card"><h3>编辑公告</h3><textarea id="admin-announcement" rows="2">${escapeHtml(currentAnn)}</textarea><button id="save-announcement">保存公告</button></div><div class="card"><h3>用户管理</h3><div><button id="batch-set-admin">设为管理员</button> <button id="batch-remove-admin">取消管理员</button> <button id="batch-mute">禁言</button> <button id="batch-unmute">解除禁言</button> <button id="batch-delete" class="danger-btn">删除</button> <label><input type="checkbox" id="select-all"> 全选</label></div><div class="table-wrapper"><table><thead><tr><th></th><th>用户名</th><th>管理员</th><th>禁言</th><th>操作</th></tr></thead><tbody>${tableRows}</tbody></table></div></div><div class="card"><h3>创建新用户</h3><input id="new-admin-name" placeholder="用户名"><input id="new-admin-pwd" placeholder="密码"><button id="admin-create-user">创建</button></div><button onclick="location.reload()">返回</button></div>`;
    document.getElementById('root').innerHTML = html;
    // 绑定管理员事件
    document.getElementById('save-announcement')?.addEventListener('click', async () => {
        const content = document.getElementById('admin-announcement').value;
        if (!content) return;
        await _supabase.from('announcements').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await _supabase.from('announcements').insert({ content, created_by: currentUser.id });
        alert('公告已更新');
        showAdminPage();
    });
    const selectAll = document.getElementById('select-all');
    if (selectAll) selectAll.onchange = e => document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = e.target.checked);
    function getSelected() { return Array.from(document.querySelectorAll('.user-checkbox:checked')).map(cb => cb.value).filter(id => id !== currentUser.id); }
    document.getElementById('batch-set-admin')?.addEventListener('click', async () => {
        const ids = getSelected(); if (!ids.length) return alert('请选择用户');
        for (const id of ids) await _supabase.from('public_profiles').update({ is_admin: true }).eq('id', id);
        alert('完成'); showAdminPage();
    });
    document.getElementById('batch-remove-admin')?.addEventListener('click', async () => {
        const ids = getSelected(); if (!ids.length) return alert('请选择用户');
        for (const id of ids) await _supabase.from('public_profiles').update({ is_admin: false }).eq('id', id);
        alert('完成'); showAdminPage();
    });
    document.getElementById('batch-mute')?.addEventListener('click', async () => {
        const ids = getSelected(); if (!ids.length) return alert('请选择用户');
        for (const id of ids) await _supabase.from('public_profiles').update({ is_muted: true }).eq('id', id);
        alert('完成'); showAdminPage();
    });
    document.getElementById('batch-unmute')?.addEventListener('click', async () => {
        const ids = getSelected(); if (!ids.length) return alert('请选择用户');
        for (const id of ids) await _supabase.from('public_profiles').update({ is_muted: false }).eq('id', id);
        alert('完成'); showAdminPage();
    });
    document.getElementById('batch-delete')?.addEventListener('click', async () => {
        const ids = getSelected(); if (!ids.length) return alert('请选择用户');
        if (confirm(`删除 ${ids.length} 个用户？`)) {
            for (const id of ids) {
                await _supabase.from('public_profiles').update({ deleted_at: new Date().toISOString() }).eq('id', id);
                await _supabase.from('friendships').delete().or(`user_id.eq.${id},friend_id.eq.${id}`);
            }
            alert('完成'); showAdminPage();
        }
    });
    document.querySelectorAll('.set-admin').forEach(btn => btn.onclick = async function() {
        const userId = this.dataset.id;
        if (userId === currentUser.id) return alert('不能对自己操作');
        await _supabase.from('public_profiles').update({ is_admin: true }).eq('id', userId);
        alert('已设为管理员'); showAdminPage();
    });
    document.querySelectorAll('.toggle-mute').forEach(btn => btn.onclick = async function() {
        const userId = this.dataset.id;
        if (userId === currentUser.id) return alert('不能对自己操作');
        const { data: user } = await _supabase.from('public_profiles').select('is_muted').eq('id', userId).single();
        await _supabase.from('public_profiles').update({ is_muted: !user.is_muted }).eq('id', userId);
        alert(!user.is_muted ? '已禁言' : '已解除禁言'); showAdminPage();
    });
    document.querySelectorAll('.admin-del').forEach(btn => btn.onclick = async function() {
        const userId = this.dataset.id;
        if (userId === currentUser.id) return alert('不能删除自己');
        if (!confirm('删除该用户？')) return;
        await _supabase.from('public_profiles').update({ deleted_at: new Date().toISOString() }).eq('id', userId);
        await _supabase.from('friendships').delete().or(`user_id.eq.${userId},friend_id.eq.${userId}`);
        alert('已删除'); showAdminPage();
    });
    document.getElementById('admin-create-user')?.addEventListener('click', async () => {
        const username = document.getElementById('new-admin-name').value.trim();
        const pwd = document.getElementById('new-admin-pwd').value;
        if (!username || !pwd) return alert('请填写');
        const { data: existing } = await _supabase.from('public_profiles').select('id').eq('display_name', username).is('deleted_at', null).maybeSingle();
        if (existing) return alert('用户名已存在');
        const randomEmail = crypto.randomUUID() + EMAIL_SUFFIX;
        const { data, error } = await _supabase.auth.signUp({ email: randomEmail, password: pwd });
        if (error) return alert('创建失败: ' + error.message);
        if (data.user) {
            await _supabase.from('public_profiles').insert({ id: data.user.id, email: randomEmail, display_name: username, is_admin: false, is_muted: false, bio: '' });
            alert('创建成功'); showAdminPage();
        }
    });
}

// ========== 事件绑定 ==========
function attachFriendsEvents() {
    document.querySelectorAll('.friend-item').forEach(el => {
        el.addEventListener('click', () => {
            const id = el.dataset.id;
            const name = el.dataset.name;
            showChatView({ id: id, display_name: name });
        });
    });
    const userMenu = document.getElementById('user-menu-trigger');
    if (userMenu) userMenu.addEventListener('click', showActionMenu);
}

function attachChatEvents() {
    const backBtn = document.getElementById('chat-back-btn');
    if (backBtn) backBtn.onclick = () => showFriendsView();
    const sendBtn = document.getElementById('chat-send');
    const chatInput = document.getElementById('chat-input');
    if (sendBtn && chatInput) {
        const send = async () => {
            const content = chatInput.value.trim();
            if (!content) return;
            if (currentProfile.is_muted) { alert('你已被禁言'); return; }
            const { error } = await _supabase.from('messages').insert({
                from_user_id: currentUser.id,
                to_user_id: currentChatUser.id,
                content: content
            });
            if (!error) {
                chatInput.value = '';
                const container = document.getElementById('chat-messages');
                if (container) {
                    const div = document.createElement('div');
                    div.className = 'message sent';
                    div.innerHTML = `<div class="bubble">${renderMessageContent(content)}</div><div class="message-time">${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</div>`;
                    container.appendChild(div);
                    container.scrollTop = container.scrollHeight;
                }
            } else alert('发送失败: ' + error.message);
        };
        sendBtn.onclick = send;
        chatInput.onkeypress = e => { if (e.key === 'Enter') send(); };
    }
    const emojiBtn = document.getElementById('emoji-btn');
    const emojiPicker = document.getElementById('emoji-picker');
    if (emojiBtn && emojiPicker) {
        emojiBtn.onclick = e => { e.stopPropagation(); emojiPicker.classList.toggle('active'); };
        document.addEventListener('click', () => emojiPicker.classList.remove('active'));
        document.querySelectorAll('.emoji-item').forEach(el => el.addEventListener('click', function() {
            const input = document.getElementById('chat-input');
            if (input) { input.value += this.innerText; input.focus(); }
            emojiPicker.classList.remove('active');
        }));
    }
    const fileBtn = document.getElementById('file-btn');
    const fileInput = document.getElementById('file-input');
    if (fileBtn && fileInput) {
        fileBtn.onclick = () => fileInput.click();
        fileInput.onchange = async e => {
            const file = e.target.files[0];
            if (file) await sendMessageWithFile(file);
            fileInput.value = '';
        };
    }
    // 长按菜单
    const messageDivs = document.querySelectorAll('.message');
    messageDivs.forEach(msgDiv => {
        msgDiv.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const messageId = msgDiv.dataset.messageId;
            const isSent = msgDiv.classList.contains('sent');
            if (!isSent) return;
            const existingMenu = document.querySelector('.context-menu');
            if (existingMenu) existingMenu.remove();
            const menu = document.createElement('div');
            menu.className = 'context-menu';
            menu.style.top = e.clientY + 'px';
            menu.style.left = e.clientX + 'px';
            menu.innerHTML = '<div class="context-menu-item" data-action="copy">复制文本</div><div class="context-menu-item" data-action="delete">删除消息</div>';
            document.body.appendChild(menu);
            const handleClick = (e2) => {
                const action = e2.target.closest('.context-menu-item')?.dataset.action;
                if (action === 'copy') {
                    const content = msgDiv.dataset.messageContent;
                    if (content) navigator.clipboard.writeText(content).then(() => alert('已复制')).catch(() => alert('复制失败'));
                } else if (action === 'delete') {
                    if (confirm('删除这条消息？')) deleteMessage(messageId);
                }
                menu.remove();
                document.removeEventListener('click', handleClick);
            };
            setTimeout(() => document.addEventListener('click', handleClick), 10);
        });
    });
    // 更多菜单
    const moreBtn = document.getElementById('chat-more-btn');
    if (moreBtn) moreBtn.onclick = () => {
        const existing = document.querySelector('.chat-more-menu');
        if (existing) existing.remove();
        const menu = document.createElement('div');
        menu.className = 'chat-more-menu';
        menu.innerHTML = '<div class="item" id="clear-chat">清空聊天记录</div>';
        document.body.appendChild(menu);
        const handleClick = (e) => {
            if (e.target.id === 'clear-chat') clearChatHistory();
            menu.remove();
            document.removeEventListener('click', handleClick);
        };
        setTimeout(() => document.addEventListener('click', handleClick), 10);
    };
}

// ========== 实时消息订阅 ==========
function subscribeMessages() {
    if (messagesSubscription) messagesSubscription.unsubscribe();
    messagesSubscription = _supabase.channel('new-msg').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `to_user_id=eq.${currentUser.id}` }, async payload => {
        if (currentChatUser && payload.new.from_user_id === currentChatUser.id) {
            const container = document.getElementById('chat-messages');
            if (container) {
                const div = document.createElement('div');
                div.className = 'message received';
                div.innerHTML = `<div class="bubble">${renderMessageContent(payload.new.content)}</div><div class="message-time">${new Date(payload.new.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</div>`;
                container.appendChild(div);
                container.scrollTop = container.scrollHeight;
            }
            await clearUnreadForUser(payload.new.from_user_id);
            await loadUnreadCounts();
            await showFriendsView();
        }
    }).subscribe();
}

// ========== 初始化应用 ==========
async function initApp() {
    const appHtml = `<div class="app" id="app"><div class="view-container friends-view" id="friends-view"><div id="friends-content"></div></div><div class="view-container chat-view" id="chat-view"><div id="chat-content"></div></div></div>`;
    document.getElementById('root').innerHTML = appHtml;
    await showFriendsView();
    subscribeMessages();
}

// ========== 认证 ==========
function renderAuth() {
    return `<div class="login-container"><div class="login-card"><h2>JChat</h2><div id="auth-error" class="error-msg"></div><input type="text" id="auth-username" placeholder="用户名"><input type="password" id="auth-password" placeholder="密码"><button id="auth-submit">登录</button><div class="auth-switch" id="auth-switch">没有账号？注册</div></div></div>`;
}

let authIsLogin = true;
function attachAuthEvents() {
    const submit = document.getElementById('auth-submit');
    const switchBtn = document.getElementById('auth-switch');
    const errorDiv = document.getElementById('auth-error');
    async function handleAuth() {
        errorDiv.innerText = '';
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value;
        if (!username || !password) { errorDiv.innerText = '请填写用户名和密码'; return; }
        const originalText = submit.innerText;
        submit.disabled = true;
        submit.innerText = authIsLogin ? '登录中...' : '注册中...';
        try {
            if (authIsLogin) {
                const { data: profile } = await _supabase.from('public_profiles').select('email').eq('display_name', username).maybeSingle();
                if (!profile) throw new Error('用户名不存在');
                const { error } = await _supabase.auth.signInWithPassword({ email: profile.email, password: password });
                if (error) throw new Error(error.message);
                const { data: { user } } = await _supabase.auth.getUser();
                currentUser = user;
                await ensureProfile(currentUser, username);
                currentProfile = await fetchCurrentProfile();
                await loadUnreadCounts();
                await initApp();
            } else {
                const { data: existing } = await _supabase.from('public_profiles').select('id').eq('display_name', username).is('deleted_at', null).maybeSingle();
                if (existing) throw new Error('用户名已被占用');
                const randomEmail = crypto.randomUUID() + EMAIL_SUFFIX;
                const { data, error } = await _supabase.auth.signUp({ email: randomEmail, password: password });
                if (error) throw new Error(error.message);
                if (data.user) {
                    currentUser = data.user;
                    await ensureProfile(currentUser, username);
                    currentProfile = await fetchCurrentProfile();
                    await loadUnreadCounts();
                    await initApp();
                } else throw new Error('注册失败');
            }
        } catch (err) { errorDiv.innerText = err.message; }
        finally { submit.disabled = false; submit.innerText = originalText; }
    }
    submit.onclick = handleAuth;
    switchBtn.onclick = function() {
        authIsLogin = !authIsLogin;
        submit.innerText = authIsLogin ? '登录' : '注册';
        switchBtn.innerText = authIsLogin ? '没有账号？注册' : '已有账号？登录';
        errorDiv.innerText = '';
    };
}

async function renderRoot() {
    const { data: { session } } = await _supabase.auth.getSession();
    if (session && session.user) {
        currentUser = session.user;
        try {
            currentProfile = await fetchCurrentProfile();
            await loadUnreadCounts();
            await initApp();
        } catch (err) { console.error(err); document.getElementById('root').innerHTML = '<div style="text-align:center;padding:40px;">加载失败，请刷新页面或重新登录</div>'; }
    } else {
        document.getElementById('root').innerHTML = renderAuth();
        attachAuthEvents();
    }
}
renderRoot();
