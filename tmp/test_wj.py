import requests

API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MDgyMDIyOTc3NDcsImlhdCI6MTc3NjY2NjI5Nywia2V5IjoiNUs3NVo4VE5DOUY0SE0zN1A5WTcifQ.cSPgl9bL7-q5D5hQHYZxe-sfu3qHdUnoHrE9IVXcsfA"
MODEL = "claude-sonnet-4-5-20250929"
url = "https://maas-openapi.wanjiedata.com/api/anthropic/v1/messages"
headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}
payload = {
    "model": MODEL,
    "messages": [
        {
            "role": "user",
            "content": "Who are you?"
        }
    ],
    "stream": False
}

response = requests.post(url, headers=headers, json=payload)

print("状态码:", response.status_code)
try:
    print("返回内容:", response.json())
except Exception:
    print("不是 JSON 内容，原始响应：")
    print(response.text)
