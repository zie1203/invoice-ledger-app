(function(){
"use strict";

/* ============================== constants ============================== */

var COMPANY = {
  name: "2MG INCORPORATED",
  addressLines: [
    "Unit 301 and 305, No. 17 Vatican Bldg,",
    "Vatican City Drive, B.F. Resort Village,",
    "Talon Dos, Las Pinas City,",
    "Metro Manila, Philippines",
    "c/o Yash Parmar",
    "getmedsindia@outlook.com",
    "ph +91 81280 98273"
  ]
};

var DEFAULT_BANK = {
  bankName: "EASTWEST BANK",
  accountName: "2MG INCORPORATED",
  branchAddress: "10 Bf RESORT DR, BF RESORT VILLAGE, LAS PINAS CITY, Metro Manila, Philippines",
  accountNo: "200045284173"
};

var STATUS_LABELS = { draft: "Draft", sent: "Sent", paid: "Paid" };

/* ============================== state ============================== */

var STATE = { invoices: [] };
var STATE_VERSION = 0;          // optimistic-concurrency token from the server
var LOADED = false;             // true once the first GET /api/state completes
var SAVING = false;

var VIEW = { name: "archive", invoiceId: null };  // per-viewer nav state, not persisted
var FILTER_TEXT = "";

/* ============================== helpers ============================== */

function uid(prefix){
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

function escapeHtml(str){
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function formatMoney(n){
  n = Number(n) || 0;
  var neg = n < 0;
  n = Math.abs(n);
  var s = n.toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2});
  return (neg ? "-" : "") + s;
}

function formatDateLong(iso){
  if (!iso) return "";
  var parts = iso.split("-");
  if (parts.length !== 3) return iso;
  var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var y = parts[0], m = parseInt(parts[1],10)-1, d = parseInt(parts[2],10);
  if (m<0||m>11) return iso;
  return months[m] + " " + d + ", " + y;
}

function todayISO(){
  var d = new Date();
  var mm = String(d.getMonth()+1).padStart(2,"0");
  var dd = String(d.getDate()).padStart(2,"0");
  return d.getFullYear()+"-"+mm+"-"+dd;
}

function nextInvoiceNo(){
  var d = new Date();
  var prefix = d.getFullYear() + String(d.getMonth()+1).padStart(2,"0");
  var count = STATE.invoices.filter(function(inv){
    return inv.invoiceNo && inv.invoiceNo.indexOf(prefix + "_") === 0;
  }).length;
  return prefix + "_" + String(count+1).padStart(4,"0");
}

/* ---- number to words (PHP) ---- */
function numberToWords(num){
  var ones = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten",
    "Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
  var tens = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  var scales = ["","Thousand","Million","Billion"];

  function threeDigits(n){
    var s = "";
    if (n >= 100){
      s += ones[Math.floor(n/100)] + " Hundred";
      n = n % 100;
      if (n > 0) s += " ";
    }
    if (n >= 20){
      s += tens[Math.floor(n/10)];
      if (n % 10 > 0) s += "-" + ones[n%10];
    } else if (n > 0){
      s += ones[n];
    }
    return s;
  }

  num = Math.floor(Math.abs(num));
  if (num === 0) return "Zero";
  var groups = [];
  while (num > 0){
    groups.unshift(num % 1000);
    num = Math.floor(num/1000);
  }
  var parts = [];
  for (var i=0;i<groups.length;i++){
    var g = groups[i];
    if (g === 0) continue;
    var scaleIdx = groups.length - 1 - i;
    parts.push(threeDigits(g) + (scales[scaleIdx] ? " " + scales[scaleIdx] : ""));
  }
  return parts.join(" ");
}

function amountInWordsPHP(total){
  total = Number(total) || 0;
  var pesos = Math.floor(Math.abs(total));
  var centavos = Math.round((Math.abs(total) - pesos) * 100);
  var words = numberToWords(pesos) + " Peso" + (pesos === 1 ? "" : "s");
  if (centavos > 0){
    words += " and " + numberToWords(centavos) + " Centavo" + (centavos === 1 ? "" : "s");
  } else {
    words += " Only";
  }
  return words;
}

/* ---- line item math ---- */
function lineAmount(item){
  if (item.type === "note"){
    return Number(item.manualAmount) || 0;
  }
  if (item.manualAmount !== null && item.manualAmount !== undefined && item.manualAmount !== ""){
    return Number(item.manualAmount) || 0;
  }
  var q = Number(item.quantity) || 0;
  var r = Number(item.rate) || 0;
  return q * r;
}

function invoiceTotal(inv){
  var t = 0;
  (inv.lineItems||[]).forEach(function(item){
    if (item.type === "note") return; // memo lines don't count toward total
    t += lineAmount(item);
  });
  return t;
}

/* ============================== default invoice ============================== */

function blankInvoice(){
  return {
    id: uid("inv"),
    invoiceNo: nextInvoiceNo(),
    invoiceDate: todayISO(),
    buyersOrderNo: "",
    buyersOrderDate: "",
    otherReference: "",
    billingAddress: "",
    consigneeName: "",
    consigneeAddress: "",
    buyerSameAsConsignee: true,
    buyerName: "",
    buyerAddress: "",
    countryOfFinalDestination: "Philippines",
    portOfDischarge: "Manila",
    shipmentMode: "",
    paymentTerms: "",
    countryOfOrigin: "INDIA",
    lineItems: [
      { id: uid("li"), type:"item", description:"", brandName:"", hsnCode:"", quantity:"", rate:"", manualAmount:null }
    ],
    amountInWordsOverride: null,
    bank: Object.assign({}, DEFAULT_BANK),
    status: "draft",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

/* ============================== persistence (server-backed) ==============================
   The shared archive lives in the backend (see server.js / data/state.json), not in this
   page's own HTML. This page always talks to /api/state — GET to load, PUT to save — with a
   simple version number for optimistic concurrency: if someone else saved in between, the
   server replies 409 and we adopt their version rather than clobbering it. */

function scheduleToast(msg){
  var el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(scheduleToast._t);
  scheduleToast._t = setTimeout(function(){ el.classList.remove("show"); }, 2600);
}

function showConnBanner(msg){
  var el = document.getElementById("conn-banner");
  if (!el){
    el = document.createElement("div");
    el.id = "conn-banner";
    el.className = "conn-banner offline";
    document.body.appendChild(el);
  }
  el.textContent = msg;
}
function hideConnBanner(){
  var el = document.getElementById("conn-banner");
  if (el) el.remove();
}

function loadState(){
  return fetch("/api/state")
    .then(function(res){
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data){
      STATE = { invoices: Array.isArray(data.invoices) ? data.invoices : [] };
      STATE_VERSION = data.version || 0;
      LOADED = true;
      hideConnBanner();
      render();
    })
    .catch(function(err){
      showConnBanner("Can't reach the server — check your connection. Retrying…");
      setTimeout(loadState, 4000);
    });
}

function persist(successMsg){
  if (!LOADED) return; // never save over a state we haven't actually loaded yet
  SAVING = true;
  fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: STATE_VERSION, invoices: STATE.invoices })
  })
    .then(function(res){ return res.json().then(function(body){ return { ok: res.ok, status: res.status, body: body }; }); })
    .then(function(result){
      SAVING = false;
      if (result.ok){
        STATE_VERSION = result.body.version;
        hideConnBanner();
        if (successMsg) scheduleToast(successMsg);
      } else if (result.status === 409){
        // someone else saved first — adopt their version, don't overwrite it
        STATE = { invoices: result.body.invoices || [] };
        STATE_VERSION = result.body.version;
        render();
        scheduleToast("Someone else just saved changes — refreshed with the latest");
      } else {
        showConnBanner("Save failed — will keep retrying in the background");
        setTimeout(function(){ persist(successMsg); }, 4000);
      }
    })
    .catch(function(){
      SAVING = false;
      showConnBanner("Can't reach the server — your last change hasn't saved yet");
      setTimeout(function(){ persist(successMsg); }, 4000);
    });
}

// Light polling so other people's saves show up without a manual refresh.
// Only refetches while looking at the archive list, so it never disturbs
// someone actively typing in the editor.
function pollForUpdates(){
  if (VIEW.name === "archive" && LOADED && !SAVING){
    fetch("/api/state").then(function(res){
      if (!res.ok) return;
      return res.json();
    }).then(function(data){
      if (data && data.version && data.version !== STATE_VERSION){
        STATE = { invoices: Array.isArray(data.invoices) ? data.invoices : [] };
        STATE_VERSION = data.version;
        render();
      }
    }).catch(function(){ /* ignore — next poll will retry */ });
  }
}
setInterval(pollForUpdates, 8000);
window.addEventListener("focus", pollForUpdates);

/* ============================== rendering ============================== */

var appEl = document.getElementById("app");

function render(){
  if (VIEW.name === "editor"){
    appEl.innerHTML = renderShell(renderEditor());
  } else {
    appEl.innerHTML = renderShell(renderArchive());
  }
  wireEvents();
}

function renderShell(mainHtml){
  return (
    '<div class="sidebar">' +
      '<div class="brand"><div class="mark">2MG</div><div class="sub">Invoice Ledger</div></div>' +
      '<button class="new-invoice-btn" data-action="new-invoice">+ New Invoice</button>' +
      '<div class="nav">' +
        '<button class="' + (VIEW.name==="archive"?"active":"") + '" data-action="go-archive">Archive</button>' +
      '</div>' +
      '<div class="sidebar-foot">2MG Incorporated<br>Finance &middot; Invoice Ledger</div>' +
    '</div>' +
    '<div class="main">' + mainHtml + '</div>'
  );
}

function renderArchive(){
  var invoices = STATE.invoices.slice().sort(function(a,b){ return b.updatedAt - a.updatedAt; });
  if (FILTER_TEXT.trim()){
    var q = FILTER_TEXT.trim().toLowerCase();
    invoices = invoices.filter(function(inv){
      return (inv.invoiceNo||"").toLowerCase().indexOf(q) > -1 ||
             (inv.consigneeName||"").toLowerCase().indexOf(q) > -1;
    });
  }

  var totalValue = STATE.invoices.reduce(function(s,inv){ return s + invoiceTotal(inv); }, 0);
  var draftCount = STATE.invoices.filter(function(i){return i.status==="draft";}).length;
  var paidCount = STATE.invoices.filter(function(i){return i.status==="paid";}).length;

  var html = '';
  html += '<div class="archive-head">';
  html += '<div><h1>Invoice Archive</h1><p>Every Pro Forma Invoice, in one place — create, edit, and export to PDF.</p></div>';
  html += '<input class="search-box" type="text" placeholder="Search invoice no. or client…" value="'+escapeHtml(FILTER_TEXT)+'" data-action="filter">';
  html += '</div>';

  html += '<div class="stat-row">';
  html += '<div class="stat-card"><div class="label">Total invoices</div><div class="value">'+STATE.invoices.length+'</div></div>';
  html += '<div class="stat-card"><div class="label">Drafts</div><div class="value">'+draftCount+'</div></div>';
  html += '<div class="stat-card"><div class="label">Paid</div><div class="value">'+paidCount+'</div></div>';
  html += '<div class="stat-card"><div class="label">Archive value (PHP)</div><div class="value">'+formatMoney(totalValue)+'</div></div>';
  html += '</div>';

  if (!invoices.length){
    html += '<div class="empty-state"><h3>No invoices yet</h3><p>Click “+ New Invoice” to create your first Pro Forma Invoice.</p></div>';
  } else {
    html += '<div class="invoice-grid">';
    invoices.forEach(function(inv){
      var total = invoiceTotal(inv);
      html += '<div class="invoice-card">';
      html += '<div class="col-main">';
      html += '<div class="inv-no">'+escapeHtml(inv.invoiceNo)+'</div>';
      html += '<div class="client">'+escapeHtml(inv.consigneeName || "Untitled client")+'</div>';
      html += '<div class="meta">'+escapeHtml(formatDateLong(inv.invoiceDate))+'</div>';
      html += '</div>';
      html += '<div class="total num">PHP '+formatMoney(total)+'</div>';
      html += '<span class="pill '+inv.status+'">'+STATUS_LABELS[inv.status]+'</span>';
      html += '<div class="card-actions">';
      html += '<button class="icon-btn primary" data-action="edit-invoice" data-id="'+inv.id+'">Edit</button>';
      html += '<button class="icon-btn" data-action="duplicate-invoice" data-id="'+inv.id+'">Duplicate</button>';
      html += '<button class="icon-btn" data-action="export-pdf" data-id="'+inv.id+'">Export PDF</button>';
      html += '<button class="icon-btn danger" data-action="delete-invoice" data-id="'+inv.id+'">Delete</button>';
      html += '</div>';
      html += '</div>';
    });
    html += '</div>';
  }
  return html;
}

function currentInvoice(){
  return STATE.invoices.find(function(i){ return i.id === VIEW.invoiceId; });
}

function renderEditor(){
  var inv = currentInvoice();
  if (!inv){ VIEW.name = "archive"; return renderArchive(); }
  var total = invoiceTotal(inv);
  var wordsValue = inv.amountInWordsOverride !== null && inv.amountInWordsOverride !== undefined
    ? inv.amountInWordsOverride : amountInWordsPHP(total);

  var html = '';
  html += '<div class="editor-head">';
  html += '<button class="back-btn" data-action="go-archive">&larr; Archive</button>';
  html += '<h1>'+escapeHtml(inv.invoiceNo)+'</h1>';
  html += '<span class="save-status" id="save-status"></span>';
  html += '<button class="btn ghost" data-action="export-pdf" data-id="'+inv.id+'">Export PDF</button>';
  html += '<button class="btn primary" data-action="save-invoice">Save</button>';
  html += '</div>';

  // Invoice details
  html += '<div class="card"><h2>Invoice Details</h2><div class="grid cols-4">';
  html += field("Invoice No.","invoiceNo",inv.invoiceNo,"text");
  html += field("Invoice Date","invoiceDate",inv.invoiceDate,"date");
  html += field("Buyer's Order No.","buyersOrderNo",inv.buyersOrderNo,"text");
  html += field("Buyer's Order Date","buyersOrderDate",inv.buyersOrderDate,"date");
  html += '</div><div class="grid cols-2" style="margin-top:16px;">';
  html += field("Other Reference(s)","otherReference",inv.otherReference,"text");
  html += selectField("Status","status",inv.status,[["draft","Draft"],["sent","Sent"],["paid","Paid"]]);
  html += '</div></div>';

  // Billing address
  html += '<div class="card"><h2>Billing Address</h2>';
  html += textareaField("Billing Address","billingAddress",inv.billingAddress,3);
  html += '</div>';

  // Consignee / buyer
  html += '<div class="card"><h2>Consignee &amp; Buyer</h2><div class="grid cols-2">';
  html += field("Consignee Name","consigneeName",inv.consigneeName,"text");
  html += field("Country of Final Destination","countryOfFinalDestination",inv.countryOfFinalDestination,"text");
  html += '</div><div style="margin-top:16px;">';
  html += textareaField("Consignee Address","consigneeAddress",inv.consigneeAddress,3);
  html += '</div>';
  html += '<div class="checkbox-row" style="margin-top:14px;"><input type="checkbox" id="chk-same-buyer" data-action="toggle-same-buyer" '+(inv.buyerSameAsConsignee?"checked":"")+'> Buyer is the same as consignee</div>';
  if (!inv.buyerSameAsConsignee){
    html += '<div class="grid cols-2" style="margin-top:14px;">';
    html += field("Buyer Name","buyerName",inv.buyerName,"text");
    html += '</div><div style="margin-top:16px;">';
    html += textareaField("Buyer Address","buyerAddress",inv.buyerAddress,3);
    html += '</div>';
  }
  html += '</div>';

  // Terms of delivery and payment
  html += '<div class="card"><h2>Terms of Delivery and Payment</h2><div class="grid cols-3">';
  html += field("Port of Discharge","portOfDischarge",inv.portOfDischarge,"text");
  html += field("Shipment Mode","shipmentMode",inv.shipmentMode,"text");
  html += field("Payment Terms","paymentTerms",inv.paymentTerms,"text");
  html += '</div></div>';

  // Line items
  html += '<div class="card"><h2>Line Items</h2><div class="table-wrap"><table class="items">';
  html += '<thead><tr><th style="width:34px;">Sr.</th><th>Description of Goods</th><th>Brand Name</th><th>HSN Code</th><th class="num-col" style="width:90px;">Qty</th><th class="num-col" style="width:110px;">Rate/Unit</th><th class="num-col" style="width:120px;">Amount (PHP)</th><th style="width:44px;"></th></tr></thead><tbody>';
  (inv.lineItems||[]).forEach(function(item,idx){
    var amt = lineAmount(item);
    if (item.type === "note"){
      html += '<tr class="note-row" data-li="'+item.id+'">';
      html += '<td>'+(idx+1)+'</td>';
      html += '<td colspan="4"><input type="text" data-li-field="description" placeholder="Note (e.g. Downpayment 35%)" value="'+escapeHtml(item.description)+'"></td>';
      html += '<td></td>';
      html += '<td><input type="text" class="amt" data-li-field="manualAmount" value="'+escapeHtml(item.manualAmount!==null&&item.manualAmount!==undefined?item.manualAmount:"")+'" placeholder="0.00"></td>';
      html += '<td class="row-actions"><button class="icon-btn danger" data-action="remove-line" data-li="'+item.id+'">&times;</button></td>';
      html += '</tr>';
    } else {
      html += '<tr data-li="'+item.id+'">';
      html += '<td>'+(idx+1)+'</td>';
      html += '<td><input type="text" data-li-field="description" value="'+escapeHtml(item.description)+'"></td>';
      html += '<td><input type="text" data-li-field="brandName" value="'+escapeHtml(item.brandName)+'"></td>';
      html += '<td><input type="text" data-li-field="hsnCode" value="'+escapeHtml(item.hsnCode)+'"></td>';
      html += '<td><input type="text" class="amt" data-li-field="quantity" value="'+escapeHtml(item.quantity)+'"></td>';
      html += '<td><input type="text" class="amt" data-li-field="rate" value="'+escapeHtml(item.rate)+'"></td>';
      html += '<td class="amt-cell num">'+formatMoney(amt)+'</td>';
      html += '<td class="row-actions"><button class="icon-btn danger" data-action="remove-line" data-li="'+item.id+'">&times;</button></td>';
      html += '</tr>';
    }
  });
  html += '</tbody></table></div>';
  html += '<div class="add-row-btns">';
  html += '<button class="btn ghost" data-action="add-item-line">+ Add Item</button>';
  html += '<button class="btn ghost" data-action="add-note-line">+ Add Note Line</button>';
  html += '</div>';
  html += '<div class="totals-row"><div class="totals-box"><div class="label">Total in PHP</div><div class="amount num">'+formatMoney(total)+'</div></div></div>';
  html += '</div>';

  // Certification & words
  html += '<div class="card"><h2>Certification &amp; Amount in Words</h2><div class="grid cols-2">';
  html += field("Country of Origin","countryOfOrigin",inv.countryOfOrigin,"text");
  html += '</div><div style="margin-top:16px;">';
  html += field("Amount Chargeable (in words)","amountInWordsOverride",wordsValue,"text");
  html += '<div class="hint" style="margin-top:-8px;">Auto-generated from the total — edit to override.</div>';
  html += '</div></div>';

  // Bank details
  html += '<div class="card"><h2>Bankers Details</h2><div class="grid cols-2">';
  html += field("Account Name","bank.accountName",inv.bank.accountName,"text");
  html += field("Bank Name","bank.bankName",inv.bank.bankName,"text");
  html += '</div><div style="margin-top:16px;">';
  html += textareaField("Branch Address","bank.branchAddress",inv.bank.branchAddress,2);
  html += '</div><div class="grid cols-2" style="margin-top:16px;">';
  html += field("Account No.","bank.accountNo",inv.bank.accountNo,"text");
  html += '</div></div>';

  html += '<div class="footer-actions">';
  html += '<button class="btn ghost" data-action="export-pdf" data-id="'+inv.id+'">Export PDF</button>';
  html += '<button class="btn primary" data-action="save-invoice">Save Invoice</button>';
  html += '</div>';

  return html;
}

function field(label, name, value, type){
  return '<div class="field"><label>'+escapeHtml(label)+'</label><input type="'+type+'" data-field="'+name+'" value="'+escapeHtml(value)+'"></div>';
}
function selectField(label, name, value, options){
  var opts = options.map(function(o){
    return '<option value="'+o[0]+'"'+(o[0]===value?" selected":"")+'>'+o[1]+'</option>';
  }).join("");
  return '<div class="field"><label>'+escapeHtml(label)+'</label><select data-field="'+name+'">'+opts+'</select></div>';
}
function textareaField(label, name, value, rows){
  return '<div class="field"><label>'+escapeHtml(label)+'</label><textarea rows="'+rows+'" data-field="'+name+'">'+escapeHtml(value)+'</textarea></div>';
}

/* ============================== field write-back (supports dot paths) ============================== */

function setPath(obj, path, value){
  var parts = path.split(".");
  var cur = obj;
  for (var i=0;i<parts.length-1;i++){ cur = cur[parts[i]]; }
  cur[parts[parts.length-1]] = value;
}

/* ============================== events ============================== */

function wireEvents(){
  appEl.oninput = function(e){
    var t = e.target;
    if (t.matches("[data-field]")){
      var inv = currentInvoice();
      if (!inv) return;
      var name = t.getAttribute("data-field");
      if (name === "amountInWordsOverride"){
        inv.amountInWordsOverride = t.value;
      } else {
        setPath(inv, name, t.value);
      }
      inv.updatedAt = Date.now();
    } else if (t.matches("[data-li-field]")){
      var row = t.closest("[data-li]");
      var liId = row.getAttribute("data-li");
      var inv2 = currentInvoice();
      var item = inv2.lineItems.find(function(li){ return li.id === liId; });
      if (!item) return;
      var f = t.getAttribute("data-li-field");
      item[f] = t.value;
      inv2.updatedAt = Date.now();
      // live-update the amount cell + total without full re-render (keeps focus)
      var amt = lineAmount(item);
      var amtCell = row.querySelector(".amt-cell");
      if (amtCell) amtCell.textContent = formatMoney(amt);
      var totalEl = document.querySelector(".totals-box .amount");
      if (totalEl) totalEl.textContent = formatMoney(invoiceTotal(inv2));
    } else if (t.matches(".search-box")){
      FILTER_TEXT = t.value;
      render();
      var sb = document.querySelector(".search-box");
      if (sb){ sb.focus(); sb.selectionStart = sb.selectionEnd = sb.value.length; }
    }
  };

  appEl.onchange = function(e){
    var t = e.target;
    if (t.id === "chk-same-buyer"){
      var inv = currentInvoice();
      inv.buyerSameAsConsignee = t.checked;
      inv.updatedAt = Date.now();
      render();
    }
  };

  appEl.onclick = function(e){
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    var id = btn.getAttribute("data-id");

    if (action === "new-invoice"){
      var inv = blankInvoice();
      STATE.invoices.push(inv);
      VIEW = { name:"editor", invoiceId: inv.id };
      render();
      persist();
    }
    else if (action === "go-archive"){
      VIEW = { name:"archive", invoiceId:null };
      render();
      pollForUpdates();
    }
    else if (action === "edit-invoice"){
      VIEW = { name:"editor", invoiceId:id };
      render();
    }
    else if (action === "duplicate-invoice"){
      var src = STATE.invoices.find(function(i){return i.id===id;});
      if (src){
        var copy = JSON.parse(JSON.stringify(src));
        copy.id = uid("inv");
        copy.invoiceNo = nextInvoiceNo();
        copy.status = "draft";
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        copy.lineItems.forEach(function(li){ li.id = uid("li"); });
        STATE.invoices.push(copy);
        render();
        persist("Invoice duplicated");
      }
    }
    else if (action === "delete-invoice"){
      if (confirm("Delete this invoice? This cannot be undone.")){
        STATE.invoices = STATE.invoices.filter(function(i){return i.id!==id;});
        render();
        persist("Invoice deleted");
      }
    }
    else if (action === "save-invoice"){
      var inv3 = currentInvoice();
      if (inv3) inv3.updatedAt = Date.now();
      render();
      persist("Invoice saved");
    }
    else if (action === "add-item-line"){
      var inv4 = currentInvoice();
      inv4.lineItems.push({ id: uid("li"), type:"item", description:"", brandName:"", hsnCode:"", quantity:"", rate:"", manualAmount:null });
      render();
    }
    else if (action === "add-note-line"){
      var inv5 = currentInvoice();
      inv5.lineItems.push({ id: uid("li"), type:"note", description:"", manualAmount:0 });
      render();
    }
    else if (action === "remove-line"){
      var liId = btn.getAttribute("data-li");
      var inv6 = currentInvoice();
      if (inv6.lineItems.length <= 1) return;
      inv6.lineItems = inv6.lineItems.filter(function(li){return li.id!==liId;});
      render();
    }
    else if (action === "export-pdf"){
      var inv7 = STATE.invoices.find(function(i){return i.id===id;}) || currentInvoice();
      if (inv7) exportPDF(inv7);
    }
  };
}

/* ============================== PDF export ============================== */

function exportPDF(inv){
  if (!window.jspdf || !window.jspdf.jsPDF){
    scheduleToast("PDF engine failed to load — check your connection and try again");
    return;
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ unit:"mm", format:"a4" });
  var BLUE = [30,160,218];
  var GREEN = [97,166,68];
  var BLACK = [0,0,0];
  var pageW = 210, marginX = 15;
  var contentW = pageW - marginX*2;
  var y = 16;

  doc.setFont("helvetica","bold");
  doc.setFontSize(15);
  doc.setTextColor.apply(doc, BLACK);
  doc.text(COMPANY.name, marginX, y);
  doc.setFont("helvetica","normal");
  doc.setFontSize(8);
  var addrY = y + 5;
  COMPANY.addressLines.forEach(function(line){
    doc.text(line, marginX, addrY);
    addrY += 3.6;
  });

  doc.setFont("helvetica","bold");
  doc.setFontSize(18);
  doc.setTextColor.apply(doc, BLUE);
  doc.text("PRO FORMA INVOICE", pageW - marginX, y+2, { align:"right" });
  doc.setFont("helvetica","normal");
  doc.setFontSize(9);
  doc.setTextColor.apply(doc, BLACK);
  doc.text(inv.invoiceNo, pageW - marginX, y+9, { align:"right" });
  doc.text(formatDateLong(inv.invoiceDate), pageW - marginX, y+13.5, { align:"right" });

  y = Math.max(addrY, y+16) + 4;
  doc.setDrawColor.apply(doc, BLUE);
  doc.setLineWidth(0.8);
  doc.line(marginX, y, pageW - marginX, y);
  y += 7;

  function labelText(label, x, yy){
    doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor.apply(doc, GREEN);
    doc.text(label.toUpperCase(), x, yy);
  }
  function bodyLines(text, x, yy, maxW){
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor.apply(doc, BLACK);
    var lines = doc.splitTextToSize(text || "—", maxW);
    doc.text(lines, x, yy);
    return yy + lines.length*4.2;
  }

  var colW = (contentW - 10)/2;
  var col2X = marginX + colW + 10;
  var startY = y;
  labelText("Billing Address", marginX, y);
  var endY1 = bodyLines(inv.billingAddress, marginX, y+5, colW);
  labelText("Buyer's Order No. / Date", col2X, y);
  var bo = [inv.buyersOrderNo, inv.buyersOrderDate ? formatDateLong(inv.buyersOrderDate) : ""].filter(Boolean).join("  —  ");
  var endY2 = bodyLines(bo || "—", col2X, y+5, colW);
  y = Math.max(endY1, endY2) + 3;

  if (inv.otherReference){
    labelText("Other Reference(s)", marginX, y);
    y = bodyLines(inv.otherReference, marginX, y+5, contentW) + 3;
  }

  y += 3;
  labelText("Consignee", marginX, y);
  var consText = (inv.consigneeName ? inv.consigneeName + "\n" : "") + (inv.consigneeAddress || "");
  var endY3 = bodyLines(consText, marginX, y+5, colW);

  var buyerText;
  if (inv.buyerSameAsConsignee){
    buyerText = "Same as consignee";
  } else {
    buyerText = (inv.buyerName ? inv.buyerName + "\n" : "") + (inv.buyerAddress || "");
  }
  labelText("Buyer (if other than consignee)", col2X, y);
  var endY4 = bodyLines(buyerText, col2X, y+5, colW);
  y = Math.max(endY3, endY4) + 3;

  labelText("Country of Final Destination", marginX, y);
  y = bodyLines(inv.countryOfFinalDestination, marginX, y+5, contentW) + 5;

  // Terms of delivery and payment
  doc.setFillColor.apply(doc, [246,251,253]);
  doc.rect(marginX, y-4, contentW, 6, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor.apply(doc, BLUE);
  doc.text("TERMS OF DELIVERY AND PAYMENT", marginX+2, y);
  y += 8;

  var col3W = contentW/3;
  labelText("Port of Discharge", marginX, y);
  bodyLines(inv.portOfDischarge, marginX, y+5, col3W-4);
  labelText("Shipment Mode", marginX+col3W, y);
  bodyLines(inv.shipmentMode, marginX+col3W, y+5, col3W-4);
  labelText("Payment Terms", marginX+col3W*2, y);
  var endY5 = bodyLines(inv.paymentTerms, marginX+col3W*2, y+5, col3W-4);
  y = endY5 + 6;

  // Line items table
  var body = [];
  var srCounter = 1;
  (inv.lineItems||[]).forEach(function(item){
    if (item.type === "note"){
      body.push([
        { content:(item.description||""), colSpan:5, styles:{ fontStyle:"italic", fillColor:[240,247,238] } },
        { content: formatMoney(Number(item.manualAmount)||0), styles:{ halign:"right", fontStyle:"italic", fillColor:[240,247,238] } }
      ]);
    } else {
      body.push([
        String(srCounter++),
        item.description||"",
        item.brandName||"",
        item.hsnCode||"",
        String(item.quantity||""),
        (item.rate!==""&&item.rate!==undefined&&item.rate!==null) ? formatMoney(Number(item.rate)) : "",
        formatMoney(lineAmount(item))
      ]);
    }
  });

  doc.autoTable({
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [["Sr.","Description of Goods","Brand Name","HSN Code","Qty","Rate/Unit (PHP)","Amount (PHP)"]],
    body: body,
    styles: { font:"helvetica", fontSize:8.5, cellPadding:2.4, lineColor: GREEN, lineWidth:0.2, textColor: BLACK },
    headStyles: { fillColor: BLUE, textColor: [255,255,255], fontStyle:"bold" },
    columnStyles: {
      0:{cellWidth:9},
      4:{halign:"right",cellWidth:16},
      5:{halign:"right",cellWidth:26},
      6:{halign:"right",cellWidth:28}
    },
    foot: [[ { content:"Total in PHP", colSpan:6, styles:{ halign:"right", fontStyle:"bold" } }, formatMoney(invoiceTotal(inv)) ]],
    footStyles: { fillColor: GREEN, textColor:[255,255,255], fontStyle:"bold", fontSize:9 }
  });

  y = doc.lastAutoTable.finalY + 8;
  if (y > 260){ doc.addPage(); y = 20; }

  doc.setFont("helvetica","italic"); doc.setFontSize(7.5); doc.setTextColor.apply(doc, BLACK);
  y = bodyLines("Certified that the country of origin of these goods is " + (inv.countryOfOrigin||"") + ".", marginX, y, contentW) + 3;

  labelText("Amount Chargeable (in words)", marginX, y);
  var wordsVal = inv.amountInWordsOverride !== null && inv.amountInWordsOverride !== undefined && inv.amountInWordsOverride !== ""
    ? inv.amountInWordsOverride : amountInWordsPHP(invoiceTotal(inv));
  y = bodyLines(wordsVal, marginX, y+5, contentW) + 6;

  if (y > 255){ doc.addPage(); y = 20; }
  doc.setFillColor.apply(doc, [246,251,253]);
  doc.rect(marginX, y-4, contentW, 6, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor.apply(doc, BLUE);
  doc.text("BANKERS DETAILS", marginX+2, y);
  y += 8;
  var bankText = "ACCOUNT NAME: " + (inv.bank.accountName||"") + "\n" +
                 "BANK NAME: " + (inv.bank.bankName||"") + "\n" +
                 "BRANCH ADDRESS: " + (inv.bank.branchAddress||"") + "\n" +
                 "ACCOUNT NO.: " + (inv.bank.accountNo||"");
  y = bodyLines(bankText, marginX, y, contentW);

  var pageCount = doc.internal.getNumberOfPages();
  for (var p=1;p<=pageCount;p++){
    doc.setPage(p);
    doc.setFont("helvetica","normal"); doc.setFontSize(7); doc.setTextColor(120,120,120);
    doc.text("2MG Incorporated — Pro Forma Invoice " + inv.invoiceNo, marginX, 290);
    doc.text("Page " + p + " of " + pageCount, pageW - marginX, 290, { align:"right" });
  }

  var filename = "ProForma_" + inv.invoiceNo + "_" + (inv.consigneeName||"client").replace(/[^a-z0-9]+/gi,"_") + ".pdf";
  doc.save(filename);
}

/* ============================== boot ============================== */

loadState();

})();
