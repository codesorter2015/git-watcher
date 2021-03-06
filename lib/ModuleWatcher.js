var config = global.config,
	fs = require('fs'),
	util = require('util'),
	async = require('async'),
	events = require('events'),
	chp = require('child_process'),
	GitParser = require('./GitParser');

function log() {
	if (console && config.debugMode) {
		console.log.apply(console, arguments);
	}
}

function isBinaryCheck(buffer) {
	var size = buffer.length;
	
	if (size === 0) return false;
	
	var suspiciousBytes = 0;
	var totalBytes = Math.min(size, 512);

	if (size >= 3 && buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF) {
		// UTF-8 BOM. This isn't binary.
		return false;
	}
	
	for (var i = 0; i < totalBytes; i++) {
		if (buffer[i] === 0) { // NULL byte--it's binary!
			return true;
		} else if ((buffer[i] < 7 || buffer[i] > 14) && (buffer[i] < 32 || buffer[i] > 127)) {
			// UTF-8 detection
			if (buffer[i] > 191 && buffer[i] < 224 && i + 1 < totalBytes) {
				i++;
				if (buffer[i] < 192) continue;
			} else if (buffer[i] > 223 && buffer[i] < 239 && i + 2 < totalBytes) {
				i++;
				if (buffer[i] < 192 && buffer[i + 1] < 192) {
					i++;
					continue;
				}
			}
			suspiciousBytes++;
			// Read at least 32 bytes before making a decision
			if (i > 32 && (suspiciousBytes * 100) / totalBytes > 10) {
				return true;
			}
		}
	}

	return (suspiciousBytes * 100) / totalBytes > 10;
}

var ModuleWatcher = function(baseGitRepoPath) {
	events.EventEmitter.call(this);
	var me = this;
	
	me.path = baseGitRepoPath.replace(/[\\\/]$/, '');
	me.repo = require('git-utils').open(me.path);
	me.changeTimer = null;
	me.shouldRefreshIndex = false;
};

util.inherits(ModuleWatcher, events.EventEmitter);

ModuleWatcher.prototype.init = function() {
	var me = this;
	
	log('Initializing module: ' + me.path);
	
	me.watchedPaths = [];
	me.errEmitter = require('domain').create();
	me.errEmitter.on('error', function(err) {
		console.error(err);
		me.emit('error', err);
	});
	me.fsWatchers = require('domain').create();
	me.fsWatchers.on('error', function(err) {
		console.error(err);
	});
	
	me._watchDir(me.path);
	me._watchGitRepo();
};

ModuleWatcher.prototype.close = function() {
	log('Closing module: ' + this.path);
	this.fsWatchers.members.forEach(function close(watcher) {
		watcher.close();
	});
	this.watchedPaths = [];
};

ModuleWatcher.prototype.getStatus = function(callback) {
	var me = this;
	if (me.changeTimer) {
		clearTimeout(me.changeTimer);
		me.changeTimer = null;
	}
	me._buildGitStatus(function buildGitStatusCallback(err, status) {
		if (err) return callback(err);
		me.getBranch(function getBranchCallback(err, branch) {
			if (err) return callback(err);
			status.branch = branch;
			if (config.uiOptions.showCommitLog) {
				me.getCommitLog(function(err, log) {
					if (err) return callback(err);
					status.log = log;
					callback(null, status);
				});
			} else {
				callback(null, status);
			}
		});
	});
};

ModuleWatcher.prototype.getName = function() {
	return require('path').basename(this.path);
};

ModuleWatcher.prototype.getBranch = function(callback) {
	chp.exec('git status -sb', {cwd: this.path}, function execCallback(err, stdout) {
		if (err) return callback(err);
		var match = stdout.match(/^## ([^.\n]+)(?:\.\.\.([^.\n]+?)(?: \[(ahead|behind) (\d+)\])?)?$/m);
		var branch;
		if (match) {
			var branchName = match[1].trim();
			var remoteName = match[2] ? match[2].trim() : '';
			branch = {
				ahead: match[3] === 'ahead' ? match[4] : 0,
				behind: match[3] === 'behind' ? match[4] : 0,
				name: branchName,
				remote: remoteName
			};
		} else {
			branch = null;
		}
		callback(null, branch);
	});
};

ModuleWatcher.prototype.getCommitLog = function(callback) {
	chp.exec('git log -10 --pretty=format:"%h %s"', {cwd: this.path}, function execCallback(err, stdout) {
		if (err) return callback(err);
		var regex = /^(\w+)\s+(.+)$/gm, log = [], match;
		while ((match = regex.exec(stdout)) !== null) {
			log.push({
				hash: match[1],
				subject: match[2]
			});
		}
		callback(null, log);
	});
};

ModuleWatcher.prototype.refreshIndex = function() {
	return this.repo.refreshIndex();
};

ModuleWatcher.prototype.statusChanged = function() {
	this._emitChange();
};

ModuleWatcher.prototype._watchDir = function(basePath) {
	var me = this;
	log('Watching directory:', basePath);
	var watcher = fs.watch(basePath, function onFileChange(event, fileName) {
		var fullPath = require('path').join(basePath, fileName);
		log('File changed:', fullPath);
		me._removeWatchIfNecessary(fullPath);
		me._watchDirIfNecessary(fullPath);
		me._emitChange();
	});
	me.fsWatchers.add(watcher);
	me.watchedPaths.push(basePath);
	fs.readdir(basePath, me.errEmitter.intercept(function readDirCallback(files) {
		files.forEach(function fileIterator(fileName) {
			var fullPath = require('path').join(basePath, fileName);
			me._watchDirIfNecessary(fullPath);
		});
	}));
};

ModuleWatcher.prototype._watchGitRepo = function() {
	var me = this;
	var gitFile = me.path + '/.git';
	var mergeMsgFile;
	
	function emitMergeIfNecessary() {
		fs.readFile(mergeMsgFile, {encoding: 'utf8'}, function(err, contents) {
			if (!err && contents) {
				me.emit('merge', {
					msg: contents.trim()
				});
			}
		});
	}
	
	function watch(directoryPath) {
		log('Watching repository:', directoryPath);
		mergeMsgFile = require('path').join(directoryPath, 'MERGE_MSG');
		var watcher = fs.watch(directoryPath, function onRepoFileChange(event, fileName) {
			if (['index', 'HEAD', 'COMMIT_EDITMSG', 'ORIG_HEAD', 'MERGE_MSG', 'MERGE_HEAD'].indexOf(fileName) > -1) {
				log('Git file changed:', require('path').join(directoryPath, fileName));
				if (fileName === 'MERGE_MSG') {
					emitMergeIfNecessary();
				}
				me.shouldRefreshIndex = true;
				me._emitChange();
			}
		});
		me.fsWatchers.add(watcher);
	}
	
	fs.stat(gitFile, me.errEmitter.intercept(function fileStatCallback(stat) {
		if (stat.isDirectory()) {
			watch(gitFile);
		} else {
			// submodule added with `git submodule add <url>`: fetch real repository path
			fs.readFile(gitFile, {encoding: 'utf8'}, me.errEmitter.intercept(function readFileCallback(contents) {
				var match = contents.trim().match(/^gitdir:\s*(.+)$/);
				var fullPath = require('path').resolve(me.path, match[1]);
				watch(fullPath);
			}));
		}
	}));
};

ModuleWatcher.prototype._watchDirIfNecessary = function(fullPath) {
	var me = this;
	fs.stat(fullPath, function fileStatCallback(err, stat) {
		if (err || !stat.isDirectory()) return;
		var relativePath = me.repo.relativize(fullPath);
		if (me.repo.isIgnored(relativePath)) {
			log('Ignoring path:', fullPath);
		} else if (!me._isSubmodule(relativePath) && me.watchedPaths.indexOf(fullPath) < 0) {
			me._watchDir(fullPath);
		}
	});
};

ModuleWatcher.prototype._removeWatchIfNecessary = function(fullPath) {
	var index;
	if (!fs.existsSync(fullPath) && (index = this.watchedPaths.indexOf(fullPath)) > -1) {
		log('Removing from watch list:', fullPath);
		this.watchedPaths.splice(index, 1);
	}
};

ModuleWatcher.prototype._buildGitStatus = function(callback) {
	var me = this;
	var statuses = {
		unstaged: [],
		staged: []
	};
	
	GitParser.getStatus(me.path, function gitStatusCallback(err, gitFilesStatus) {
		if (err) return callback(err);
		
		async.each(gitFilesStatus, function processGitFile(file, callback) {
			var relativeRepoFileName = file.name;
			var filePath = require('path').join(me.path, relativeRepoFileName);
			var gitFileType = me._getItemType(relativeRepoFileName);
			var isUnstaged = file.unstaged;
			var isStaged = file.staged;
			function addStatus(type, statusStr, diff, fileTypeInfo, summary) {
				statuses[type].push({
					name: relativeRepoFileName,
					path: filePath,
					type: gitFileType,
					status: statusStr,
					diff: diff || null,
					staged: isStaged,
					unstaged: isUnstaged,
					unmerged: file.unmerged,
					summary: summary || null,
					info: fileTypeInfo || {}
				});
			};
			
			async.waterfall([
				function getFileTypeInfo(callback) { // detect file mime type
					me._getFileTypeInfo(relativeRepoFileName, callback);
				},
				function buildFileDiff(fileTypeInfo, callback) { // build diff for text files
					var tasks = {};
					if (fileTypeInfo && !fileTypeInfo.isBinary) {
						if (isUnstaged) {
							tasks.unstaged = function getUnstagedFileDiff(callback) {
								me._getFileDiff(relativeRepoFileName, isStaged, 'unstaged', callback);
							};
						}
						if (isStaged) {
							tasks.staged = function getStagedFileDiff(callback) {
								me._getFileDiff(relativeRepoFileName, isStaged, 'staged', callback);
							};
						}
					}
					if (gitFileType === 'submodule') {
						tasks.summary = function getSubmoduleSummary(callback) {
							GitParser.getSubmoduleSummary(me.path, relativeRepoFileName, callback);
						};
					}
					async.parallel(tasks, function fileTasksCallback(err, results) {
						if (err) return callback(err);
						
						if (isUnstaged) {
							addStatus('unstaged', file.unstagedStatusStr, results.unstaged, fileTypeInfo, results.summary);
						}
						if (isStaged) {
							addStatus('staged', file.stagedStatusStr, results.staged, fileTypeInfo, results.summary);
						}
						callback();
					});
				}
			], callback);
		}, function(err) {
			if (err) return callback(err);
			
			statuses.unstaged.sort(me._sortFiles);
			statuses.staged.sort(me._sortFiles);
			callback(null, statuses);
		});
	});
};

ModuleWatcher.prototype._getLatestFileContentsAsBuffer = function(relativeRepoFileName, callback) {
	var me = this;
	var filePath = require('path').join(me.path, relativeRepoFileName);
	fs.exists(filePath, function fileExistsCallback(exists) {
		if (exists) {
			fs.stat(filePath, function fileStatCallback(err, stat) {
				if (err) return callback(err);
				if (stat.isDirectory()) return callback(null, null);
				fs.readFile(filePath, callback);
			});
		} else {
			callback(null, new Buffer(me.repo.getHeadBlob(relativeRepoFileName) || ''));
		}
	});
};

ModuleWatcher.prototype._getFileTypeInfo = function(relativeRepoFileName, callback) {
	var me = this;
	me._getLatestFileContentsAsBuffer(relativeRepoFileName, function(err, contents) {
		if (err) return callback(err);
		if (contents === null) return callback(null, null);
		var mimeType = require('mime-types').contentType(require('path').basename(relativeRepoFileName)) || 'application/octet-stream';
		callback(null, {
			isBinary: isBinaryCheck(contents),
			mimeType: mimeType
		});
	});
};

ModuleWatcher.prototype._sortFiles = function(a, b) {
	if (a.name < b.name) return -1;
	else if (a.name > b.name) return 1;
	return 0;
};

ModuleWatcher.prototype._getFileDiff = function(relativeRepoFileName, isStaged, type, callback) {
	var me = this;
	var filePath = require('path').join(me.path, relativeRepoFileName);
	var headFileContents = me.repo.getHeadBlob(relativeRepoFileName) || '';
	var indexFileContents = me.repo.getIndexBlob(relativeRepoFileName) || '';
	var newFileContents, oldFileContents, diff;
	if (type === 'staged') {
		newFileContents = indexFileContents;
		oldFileContents = headFileContents;
		diff = me.repo.getLineDiffs(relativeRepoFileName, indexFileContents, {useIndex: false, ignoreEolWhitespace: config.diff.ignoreEolWhitespace});
	} else {
		newFileContents = (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) ? fs.readFileSync(filePath, {encoding: 'utf8'}) : '';
		oldFileContents = isStaged ? indexFileContents : headFileContents;
		diff = me.repo.getLineDiffs(relativeRepoFileName, newFileContents, {useIndex: isStaged, ignoreEolWhitespace: config.diff.ignoreEolWhitespace});
	}
	var newLines = newFileContents.split(/\r\n|\n|\r/);
	var oldLines = oldFileContents.split(/\r\n|\n|\r/);
	if (diff === null) {
		// new unstaged file
		return callback(null, newFileContents ? [
			me._getRangeLines(null, {
				start: 0,
				end: newLines.length,
				contents: newLines
			}) 
		]: null);
	}
	var oldOffset = 0;
	var lineChunks = diff.map(function(change) {
		var oldMin = Math.max(change.oldStart-1, 0);
		var newMin = Math.max(change.newStart-1, 0);
		var oldChunk = {
			start: oldMin,  // 0-based
			end: oldMin + change.oldLines,  // 0-based
			lines: change.oldLines,
			offset: oldOffset
		};
		var newChunk = {
			start: newMin,  // 0-based
			end: newMin + change.newLines,  // 0-based
			lines: change.newLines,
			offset: 0
		};
		oldOffset += (change.newLines - change.oldLines);
		return {
			old: oldChunk,
			new: newChunk
		};
	});
	var lines = me._buildLines(lineChunks, oldLines, newLines);
	callback(null, me._buildRanges(lines));
};

ModuleWatcher.prototype._buildLines = function(lineChunks, oldLines, newLines) {
	var me = this;
	var lines = [], contextLines = config.diff.contextLines || 3;
	
	function addChunk(chunk) { // 0-based
		addLines('-', chunk.old, oldLines);
		addLines('+', chunk.new, newLines);
	}
	function addLines(type, chunk, contents) { // 0-based
		lines = lines.concat(me._getRangeLines(type, {
			start: chunk.start,
			end: chunk.end,
			contents: contents
		}));
	}
	function addContextLines(start, end) { // 0-based
		addLines(null, {start: start, end: end}, newLines);
	}
	function addSeparator() {
		lines.push({type: 'separator'});
	}
	function getRangeStart(chunk) {
		var oldStart = chunk.old.start + chunk.old.offset;
		var newStart = chunk.new.start;
		if (chunk.new.lines && chunk.old.lines) {
			return Math.min(oldStart, newStart);
		} else {
			return chunk.new.lines ? newStart : oldStart;
		}
	}
	function getRangeEnd(chunk) {
		var oldEnd = chunk.old.start + chunk.old.offset;
		var newEnd = chunk.new.end;
		if (chunk.new.lines && chunk.old.lines) {
			return Math.max(oldEnd, newEnd);
		} else {
			return chunk.new.lines ? newEnd : oldEnd;
		}
	}
	
	for (var i = 0, len = lineChunks.length; i < len; i++) {
		var nextRangeStart = i < (len - 1) ? getRangeStart(lineChunks[i+1]) : newLines.length - 1;
		var thisRangeStart = getRangeStart(lineChunks[i]);
		var thisRangeEnd = getRangeEnd(lineChunks[i]);
		var linesBetween = Math.max(nextRangeStart - thisRangeEnd, 0);
		if (i === 0) {
			addContextLines(thisRangeStart - contextLines, thisRangeStart);
		}
		addChunk(lineChunks[i]);
		if (linesBetween <= contextLines*2) {
			addContextLines(thisRangeStart + lineChunks[i].new.lines, thisRangeEnd + linesBetween);
		} else {
			addContextLines(thisRangeStart + lineChunks[i].new.lines, thisRangeEnd + contextLines);
			addSeparator();
			if (i < (len - 1)) {
				addContextLines(nextRangeStart - contextLines, nextRangeStart);
			}
		}
	}
	
	return lines;
};

ModuleWatcher.prototype._buildRanges = function(lines) {
	var ranges = [], rangeLines = [];
	for (var i = 0, len = lines.length; i < len; i++) {
		if (lines[i].type !== 'separator') {
			rangeLines.push(lines[i]);
		}
		if (lines[i].type === 'separator' || i === (len - 1)) {
			ranges.push(rangeLines);
			rangeLines = [];
		}
	}
	return ranges;
};

ModuleWatcher.prototype._getRangeLines = function(type, range) {
	var lines = [];
	for (var i = range.start; i < range.end; i++) {
		if (range.contents[i] === undefined) continue;
		lines.push({
			type: type,
			oldLine: i+1,
			newLine: i+1,
			content: range.contents[i]
		});
	}
	return lines;
};

/**
 * 
 * @param {String} relativeRepoFileName
 * @returns {String} file|submodule
 */
ModuleWatcher.prototype._getItemType = function(relativeRepoFileName) {
	if (this._isSubmodule(relativeRepoFileName)) {
		return 'submodule';
	} else {
		return 'file';
	}
};

ModuleWatcher.prototype._isSubmodule = function(relativeRepoFileName) {
	var filePath = require('path').join(this.path, relativeRepoFileName);
	return fs.existsSync(require('path').join(filePath, '.git'));
};

ModuleWatcher.prototype._emitChange = function() {
	var me = this;
	if (me.changeTimer) {
		clearTimeout(me.changeTimer);
	}
	me.changeTimer = setTimeout(function emitChange() {
		me.changeTimer = null;
		if (me.shouldRefreshIndex) {
			me.refreshIndex();
			me.shouldRefreshIndex = false;
		}
		me.getStatus(me.errEmitter.intercept(function statusCallback(status) {
			log(me.getName() + ': emitting change...');
			me.emit('change', status);
		}));
	}, 500);
};

module.exports = ModuleWatcher;
