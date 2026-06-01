# 🚀 تعليمات Replit Agent — تحويل Odysseus إلى API خاص

## ما هو المشروع؟

**Odysseus** هو workspace ذكاء اصطناعي self-hosted مبني على:
- **Backend:** FastAPI (Python)
- **Frontend:** HTML/CSS/JS (SPA)
- **Database:** SQLite
- **Vector Memory:** ChromaDB
- **Search:** SearXNG

الهدف: تشغيله على Replit وتفعيل الـ API المدمج فيه حتى تقدر تستخدمه من أي تطبيق خارجي.

---

## 📋 الخطوات للـ Replit Agent

### الخطوة 1 — استنساخ المشروع

قول للـ Agent:

```
Clone the GitHub repository https://github.com/pewdiepie-archdaemon/odysseus
into the current Replit project. Copy all files to the root directory.
```

---

### الخطوة 2 — إعداد ملف `.env`

قول للـ Agent:

```
Create a .env file in the root directory with these variables:

AUTH_ENABLED=true
LOCALHOST_BYPASS=false
DATABASE_URL=sqlite:///./data/app.db
CHROMADB_HOST=localhost
CHROMADB_PORT=8100
SEARXNG_INSTANCE=http://localhost:8080
LLM_HOST=localhost
OPENAI_API_KEY=your_openai_key_here
ODYSSEUS_ADMIN_PASSWORD=YourStrongPassword123
ALLOWED_ORIGINS=*
REQUEST_HARD_TIMEOUT=60
```

Replace "YourStrongPassword123" with a strong password. Replace OPENAI_API_KEY with your actual key if you have one.
```

---

### الخطوة 3 — تثبيت المتطلبات

قول للـ Agent:

```
Install Python dependencies from requirements.txt using pip.
Then run: python setup.py
This will create the data directories and initialize the database.
```

---

### الخطوة 4 — تشغيل السيرفر

قول للـ Agent:

```
Start the application with:
uvicorn app:app --host 0.0.0.0 --port 8000

Make sure the Replit port 8000 is exposed publicly.
```

---

### الخطوة 5 — إنشاء API Token

بعد ما يشتغل السيرفر:

1. افتح `https://your-replit-url.repl.co` في المتصفح
2. سجّل دخول بكلمة المرور اللي حددتها
3. روح إلى **Settings → API Tokens**
4. اضغط **Create Token**
5. احفظ الـ Token — لن يظهر مرة ثانية!

---

## 🔌 كيف تستخدم الـ API

### التحقق من الصحة

```bash
curl https://your-replit-url.repl.co/api/health
```

**النتيجة:**
```json
{"status": "healthy", "timestamp": "2026-01-01T00:00:00"}
```

---

### إرسال رسالة دردشة (Chat)

```bash
curl -X POST https://your-replit-url.repl.co/api/chat \
  -H "Authorization: Bearer ody_YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "مرحبا! كيف حالك؟",
    "session_id": "my-session-1",
    "model": "gpt-4o"
  }'
```

**النتيجة:**
```json
{
  "response": "مرحبا! أنا بخير، كيف يمكنني مساعدتك؟",
  "session_id": "my-session-1"
}
```

---

### إنشاء جلسة جديدة

```bash
curl -X POST https://your-replit-url.repl.co/api/sessions \
  -H "Authorization: Bearer ody_YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"name": "جلستي الجديدة"}'
```

---

### عرض كل الجلسات

```bash
curl https://your-replit-url.repl.co/api/sessions \
  -H "Authorization: Bearer ody_YOUR_TOKEN_HERE"
```

---

### استخدام الـ API من JavaScript

```javascript
const ODYSSEUS_URL = "https://your-replit-url.repl.co";
const API_TOKEN = "ody_YOUR_TOKEN_HERE";

async function chat(message, sessionId = "default") {
  const response = await fetch(`${ODYSSEUS_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: message,
      session_id: sessionId
    })
  });
  
  const data = await response.json();
  return data.response;
}

// الاستخدام
const reply = await chat("ما هي عاصمة السعودية؟");
console.log(reply);
```

---

### استخدام الـ API من Python

```python
import requests

ODYSSEUS_URL = "https://your-replit-url.repl.co"
API_TOKEN = "ody_YOUR_TOKEN_HERE"

headers = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json"
}

def chat(message, session_id="default"):
    response = requests.post(
        f"{ODYSSEUS_URL}/api/chat",
        headers=headers,
        json={
            "message": message,
            "session_id": session_id
        }
    )
    return response.json()["response"]

# الاستخدام
reply = chat("ما هو أكبر بلد في العالم؟")
print(reply)
```

---

## ⚙️ ربط نموذج ذكاء اصطناعي

### خيار 1: OpenAI (GPT-4o, GPT-4)

في ملف `.env`:
```
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
```

### خيار 2: OpenRouter (يدعم Claude, Gemini, Llama, وغيرها)

في ملف `.env`:
```
OPENAI_API_KEY=sk-or-xxxxxxxxxxxxxxxx
LLM_HOST=openrouter.ai/api/v1
```

### خيار 3: Ollama (نموذج محلي على سيرفرك)

```
LLM_HOST=your-server-ip:11434
```

---

## 🔒 نصائح الأمان

1. **لا تشارك الـ API Token** مع أحد خارج فريقك
2. **غيّر كلمة المرور** من الإعدادات بعد أول تسجيل دخول
3. **استخدم HTTPS** — Replit يوفره تلقائياً
4. أنشئ **token منفصل لكل استخدام** (تطبيق، شخص، جهاز)
5. اضغط **Delete** على أي token لا تستخدمه

---

## 📌 API Endpoints الأساسية

| Endpoint | Method | الوصف |
|----------|--------|-------|
| `/api/health` | GET | فحص حالة السيرفر |
| `/api/version` | GET | إصدار التطبيق |
| `/api/chat` | POST | إرسال رسالة والحصول على رد |
| `/api/sessions` | GET | قائمة الجلسات |
| `/api/sessions` | POST | إنشاء جلسة جديدة |
| `/api/sessions/{id}` | DELETE | حذف جلسة |
| `/api/memory` | GET | عرض الذاكرة |
| `/api/search` | POST | بحث على الويب |
| `/api/auth/status` | GET | حالة المصادقة |

---

## 🆘 حل المشاكل الشائعة

**المشكلة:** `401 Unauthorized`
**الحل:** تأكد أن الـ Token صحيح وفي الهيدر هكذا: `Authorization: Bearer ody_...`

**المشكلة:** السيرفر لا يشتغل
**الحل:** شغّل `python setup.py` أولاً ثم `uvicorn app:app --host 0.0.0.0 --port 8000`

**المشكلة:** لا يوجد نموذج AI
**الحل:** أضف `OPENAI_API_KEY` في ملف `.env` أو ربط Ollama

**المشكلة:** ChromaDB لا يتصل
**الحل:** هذا اختياري — الذاكرة تعمل بدونه. الـ API الأساسي يعمل بشكل طبيعي.
