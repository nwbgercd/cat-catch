// url 参数解析
const params = new URL(location.href).searchParams;
const _requestId = params.get("requestId") ? params.get("requestId").split(",") : [];   // 要下载得资源ID
const _ffmpeg = params.get("ffmpeg");   // 启用在线FFmpeg
let _downStream = params.get("downStream"); // 启用边下边存 流式下载
const _data = [];   // 通过_requestId获取得到得数据
const _taskId = Date.parse(new Date()); // 配合ffmpeg使用的任务ID 以便在线ffmpeg通过ID知道文件属于哪些任务
let _tabId = null;  // 当前页面tab id
let _index = null;  // 当前页面 tab index

// 是否表单提交下载 表单提交 不使用自定义文件名
let _formDownload = false;

// 获取当前标签信息
chrome.tabs.getCurrent(function (tabs) {
    _tabId = tabs.id;
    _index = tabs.index;

    // 如果没有requestId 显示 提交表单
    if (!_requestId.length) {
        $("#getURL, .newDownload").toggle();
        $("#getURL_btn").click(function () {
            const data = [{
                url: $("#getURL #url").val().trim(),
                requestHeaders: { referer: $("#getURL #referer").val().trim() },
                requestId: 1,
            }];
            _downStream = $("#downStream").prop("checked");
            _formDownload = true;   // 标记为表单提交下载
            _data.push(...data);
            setHeaders(data, () => { awaitG(start); });
            $("#getURL, .newDownload").toggle();
        });
        return;
    }
    // 读取要下载的资源数据
    chrome.runtime.sendMessage({ Message: "getData", requestId: _requestId }, function (data) {
        if (data == "error" || !Array.isArray(data) || chrome.runtime.lastError) {
            chrome.tabs.highlight({ tabs: _index });
            alert(i18n.dataFetchFailed);
            return;
        }
        _data.push(...data);
        setHeaders(data, () => { awaitG(start); });
    });
});

function start() {
    $(`<style>${G.css}</style>`).appendTo("head");
    $("#autoClose").prop("checked", G.downAutoClose);
    streamSaver.mitm = G.streamSaverConfig.url;

    const $downBox = $("#downBox"); // 下载列表容器
    const down = new Downloader(_data);  // 创建下载器 
    const itemDOM = new Map();  // 提前储存需要平凡操作的dom对象 提高效率

    // 添加html
    const addHtml = (fragment) => {
        const html = $(`
            <div class="downItem">
                <div class="explain">${stringModify(fragment.name ?? getUrlFileName(fragment.url))}</div>
                <div id="downFilepProgress"></div>
                <div class="progress-container">
                    <div class="progress-wrapper">
                        <div class="progress-bar">
                            <div class="progress"></div>
                        </div>
                    </div>
                    <button class="cancel-btn">${i18n.stopDownload}</button>
                </div>
            </div>`);

        const $button = html.find("button");
        $button.data("action", "stop");

        // 操作对象放入itemDOM 提高效率
        itemDOM.set(fragment.index, {
            progressText: html.find("#downFilepProgress"),
            progress: html.find(".progress"),
            button: $button
        });

        $button.click(function () {
            const action = $(this).data("action");
            if (action == "stop") {
                down.stop(fragment.index);
                $(this).html(i18n.retryDownload).data("action", "start");
                if (fragment.fileStream) {
                    fragment.fileStream.close();
                    fragment.fileStream = streamSaver.createWriteStream(fragment._filename).getWriter();
                }
            } else if (action == "start") {
                down.state = "waiting";
                down.downloader(fragment);
                $(this).html(i18n.stopDownload).data("action", "stop");
            } else {
                sendFile("addFile", down.buffer[fragment.index], fragment);
            }
        });
        $downBox.append(html);

        // 自定义下载文件名
        fragment._filename = getUrlFileName(fragment.url);
        if (G.TitleName && !_formDownload) {
            fragment.title = stringModify(fragment.title);    // 防止标题中有路径分隔符 导致下载新建文件夹
            fragment._filename = templates(G.downFileName, fragment);
        }
        _formDownload = false;   // 重置表单提交标记

        // 流式下载处理
        if ((_downStream || G.downStream) && !_ffmpeg) {
            fragment.fileStream = streamSaver.createWriteStream(fragment._filename).getWriter();
        }
    }

    // 下载列表添加对应html
    down.fragments.forEach(addHtml);

    // 文件进程事件
    let lastEmitted = Date.now();
    down.on('itemProgress', function (fragment, state, receivedLength, contentLength, value) {
        if (state) {
            const $dom = itemDOM.get(fragment.index);
            $dom.progress.css("width", "100%");
            $dom.progress.html("100%");
            $dom.progressText.html(i18n.downloadComplete);
            $dom.button.html(i18n.sendFfmpeg);
            $dom.button.data("action", "sendFfmpeg");
            return;
        }
        if (fragment.fileStream) {
            fragment.fileStream.write(new Uint8Array(value));
        }

        // 通过 lastEmitted 限制更新频率 避免疯狂dom操作
        if (Date.now() - lastEmitted >= 100) {
            const $dom = itemDOM.get(fragment.index);
            if (contentLength) {
                const progress = (receivedLength / contentLength * 100).toFixed(2) + "%";
                $dom.progress.css("width", progress);
                $dom.progress.html(progress);
                $dom.progressText.html(`${byteToSize(receivedLength)} / ${byteToSize(contentLength)}`);
            } else {
                $dom.progressText.html(`${byteToSize(receivedLength)}`);
            }
            if (down.total == 1) {
                const title = contentLength ?
                    `${byteToSize(receivedLength)} / ${byteToSize(contentLength)}` :
                    `${byteToSize(receivedLength)}`;
                document.title = title;
            }
            lastEmitted = Date.now();
        }
    });

    // 单文件下载完成事件
    down.on('completed', function (buffer, fragment) {
        // 是流式下载 停止写入
        if (fragment.fileStream) {
            fragment.fileStream.close();
            fragment.fileStream = null;
            return;
        }

        // 更新标题
        document.title = `${down.success}/${down.total}`;

        // 转为blob
        const blob = new Blob([buffer], { type: fragment.contentType });

        // 发送到ffmpeg
        if (_ffmpeg) {
            sendFile(_ffmpeg, blob, fragment);
            return;
        }

        // 直接下载
        chrome.downloads.download({
            url: URL.createObjectURL(blob),
            filename: filterFileName(fragment._filename),
            saveAs: G.saveAs
        }, function (downloadId) {
            fragment.downId = downloadId;
        });
    });

    // 全部下载完成事件
    down.on('allCompleted', function (buffer) {
        $("#stopDownload").hide();
    });

    // 错误处理
    down.on('downloadError', function (fragment, error) {
        // 添加range请求头 重新尝试下载
        if (!fragment.retry?.Range) {
            fragment.retry = { "Range": "bytes=0-" };
            down.downloader(fragment);
            return;
        }
        itemDOM.get(fragment.index).progressText.html(error);
        chrome.tabs.highlight({ tabs: _index });
    });

    // 开始下载事件 如果存在range重下标记 则添加 range 请求头
    down.on('start', function (fragment, options) {
        if (fragment.retry) {
            options.headers = fragment.retry;
            options.cache = "no-cache";
        }
    });

    // 全部停止下载按钮
    $("#stopDownload").click(function () {
        down.stop();
        // 更新对应的按钮状态
        itemDOM.forEach((item, index) => {
            if (item.button.data("action") == "stop") {
                item.button.html(i18n.retryDownload).data("action", "start");
                down.fragments[index].fileStream && down.fragments[index].fileStream.abort();
            }
        });
    });

    // 打开下载目录
    $(".openDir").click(function () {
        if (down.fragments[0].downId) {
            chrome.downloads.show(down.fragments[0].downId);
            return;
        }
        chrome.downloads.showDefaultFolder();
    });

    // 监听事件
    chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
        if (!Message.Message) { return; }
        // 添加下载任务
        if (Message.Message == "catDownload" && Message.data && Array.isArray(Message.data)) {
            // ffmpeg任务的下载器 不允许添加新任务
            if (_ffmpeg) {
                sendResponse({ message: "Error", tabId: _tabId });
                return;
            }
            setHeaders(Message.data, () => {
                Message.data.forEach((fragment) => {
                    _data.push(fragment);
                    down.push(fragment);
                    addHtml(fragment);
                    down.state != "running" && down.downloader(fragment.index);
                });
            });
            sendResponse({ message: "OK", tabId: _tabId });
            return;
        }
        // 在线ffmpeg返回结果 关闭窗口
        if (Message.Message != "catCatchFFmpegResult" || Message.state != "ok" || _tabId == 0 || Message.tabId != _tabId || down.success != down.total) { return; }
        if ($("#autoClose").prop("checked")) {
            setTimeout(() => {
                window.close();
            }, Math.ceil(Math.random() * 999));
        }
    });

    // 监听下载事件 下载完成 关闭窗口
    chrome.downloads.onChanged.addListener(function (downloadDelta) {
        if (!downloadDelta.state || downloadDelta.state.current != "complete") { return; }
        if (!down.fragments.some(item => item.downId == downloadDelta.id)) { return }
        if (down.success == down.total) {
            document.title = i18n.downloadComplete;
            if ($("#autoClose").prop("checked")) {
                setTimeout(() => {
                    window.close();
                }, Math.ceil(Math.random() * 999));
            }
        }
    });

    document.title = `${down.success}/${down.total}`;
    down.start();
}

/**
 * 发送数据到在线FFmpeg
 * @param {String} action 发送类型
 * @param {ArrayBuffer|Blob} data 数据内容
 * @param {Object} fragment 数据对象
 */
function sendFile(action, data, fragment) {
    // 转 blob
    if (data instanceof ArrayBuffer) {
        data = new Blob([data], { type: fragment.contentType });
    }
    chrome.tabs.query({ url: G.ffmpegConfig.url }, function (tabs) {
        // 等待ffmpeg 打开并且可用
        if (tabs.length === 0) {
            chrome.tabs.create({ url: G.ffmpegConfig.url });
            setTimeout(sendFile, 500, action, data, fragment);
            return;
        } else if (tabs[0].status !== "complete") {
            setTimeout(sendFile, 233, action, data, fragment);
            return;
        }
        /**
         * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#data_cloning_algorithm
         * chrome.runtime.sendMessage API
         * chrome 的对象参数需要序列化 无法传递Blob
         * firefox 可以直接传递Blob
         */
        const baseData = {
            Message: "catCatchFFmpeg",
            action: action,
            files: [{ data: G.isFirefox ? data : URL.createObjectURL(data), name: getUrlFileName(fragment.url) }],
            title: stringModify(fragment.title),
            tabId: _tabId,
        };
        if (action === "merge") {
            baseData.taskId = _taskId;
            baseData.quantity = _data.length;
        }

        chrome.runtime.sendMessage(baseData);
    });
}

/**
 * 设置请求头
 * @param {Array} data 请求头数据
 * @param {Function} callBack 回调函数
 */
function setHeaders(data, callBack) {
    const rules = { removeRuleIds: [], addRules: [] };
    for (let item of data) {
        const rule = {
            "id": parseInt(item.requestId),
            "action": {
                "type": "modifyHeaders",
                "requestHeaders": Object.keys(item.requestHeaders).map(key => ({ header: key, operation: "set", value: item.requestHeaders[key] }))
            },
            "condition": {
                "resourceTypes": ["xmlhttprequest", "media", "image"],
                "tabIds": [_tabId],
                "urlFilter": item.url
            }
        }
        if (item.cookie) {
            rule.action.requestHeaders.push({ header: "Cookie", operation: "set", value: item.cookie });
        }
        rules.removeRuleIds.push(parseInt(item.requestId));
        rules.addRules.push(rule);
    }
    chrome.declarativeNetRequest.updateSessionRules(rules, () => {
        callBack && callBack();
    });
}