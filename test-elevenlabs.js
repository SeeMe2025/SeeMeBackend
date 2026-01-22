// Test script for ElevenLabs API
const API_KEY = 'sk_fb5925715857efcda0ca9c57f9dbab42bd4643e6511046dd';

async function testElevenLabs() {
  try {
    console.log('Testing ElevenLabs API...\n');
    
    // Test 1: Get voices
    console.log('1. Fetching available voices...');
    const voicesResponse = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': API_KEY
      }
    });
    
    if (!voicesResponse.ok) {
      throw new Error(`Voices API error: ${voicesResponse.status} ${voicesResponse.statusText}`);
    }
    
    const voicesData = await voicesResponse.json();
    console.log(`✓ Found ${voicesData.voices.length} voices`);
    console.log(`  First voice: ${voicesData.voices[0].name} (${voicesData.voices[0].voice_id})\n`);
    
    // Test 2: Generate TTS with eleven_multilingual_v2
    console.log('2. Testing TTS with eleven_multilingual_v2 model...');
    const voiceId = voicesData.voices[0].voice_id;
    const testText = 'Hello, this is a test of the ElevenLabs API.';
    
    const ttsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: testText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );
    
    if (!ttsResponse.ok) {
      const errorText = await ttsResponse.text();
      throw new Error(`TTS API error: ${ttsResponse.status} ${ttsResponse.statusText} - ${errorText}`);
    }
    
    const audioBuffer = await ttsResponse.arrayBuffer();
    console.log(`✓ TTS generated successfully (${audioBuffer.byteLength} bytes)\n`);
    
    // Test 3: Check subscription info
    console.log('3. Checking subscription info...');
    const userResponse = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: {
        'xi-api-key': API_KEY
      }
    });
    
    if (!userResponse.ok) {
      throw new Error(`User API error: ${userResponse.status} ${userResponse.statusText}`);
    }
    
    const userData = await userResponse.json();
    console.log(`✓ Subscription: ${userData.subscription.tier}`);
    console.log(`  Character count: ${userData.subscription.character_count} / ${userData.subscription.character_limit}`);
    console.log(`  Characters remaining: ${userData.subscription.character_limit - userData.subscription.character_count}\n`);
    
    console.log('✅ All tests passed! ElevenLabs API is working correctly.');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

testElevenLabs();
