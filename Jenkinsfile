properties([
  pipelineTriggers([
    cron('H 11 * * *')
  ]),
  parameters([
    choice(name: 'PROJECT_TYPE', choices: ['TS', 'JAVA', 'BOTH'], description: 'What to run. Default TS (used by schedule).'),
    string(name: 'LOCAL_ROOT', defaultValue: 'C:/Users/yathi/Playwright', description: 'Absolute local project root path (no git checkout required).'),
    booleanParam(name: 'HEADLESS_MODE', defaultValue: false, description: 'Run browser in headless mode'),
    booleanParam(name: 'RUN_PRECHECKS', defaultValue: true, description: 'Run build/syntax prechecks before execution'),
    string(name: 'TIMEOUT_MINUTES', defaultValue: '120', description: 'Runtime timeout in minutes (applies to both Java and TS projects)'),
    string(name: 'MAX_PARALLEL_SESSIONS', defaultValue: '1', description: 'Number of parallel browser sessions (applies to both Java and TS projects)')
  ])
])

pipeline {
  agent { label 'windows-headed' }

  tools {
    maven 'Maven3'
  }

  options {
    timeout(time: 120, unit: 'MINUTES')
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '10', artifactNumToKeepStr: '10'))
  }

  environment {
    MVN_FLAGS = '-B -ntp'
  }

  stages {
    stage('Resolve Paths') {
      steps {
        script {
          env.ROOT_DIR = params.LOCAL_ROOT.replace('\\', '/')
          env.JAVA_DIR = "${env.ROOT_DIR}/playwright_java_tickets"
          env.TS_DIR = "${env.ROOT_DIR}/Playwright_TS"

          if (!fileExists("${env.JAVA_DIR}/pom.xml")) {
            error("Java project not found at: ${env.JAVA_DIR}")
          }
          if (!fileExists("${env.TS_DIR}/package.json")) {
            error("TypeScript project not found at: ${env.TS_DIR}")
          }

          echo "ROOT_DIR=${env.ROOT_DIR}"
          echo "JAVA_DIR=${env.JAVA_DIR}"
          echo "TS_DIR=${env.TS_DIR}"
          echo "PROJECT_TYPE=${params.PROJECT_TYPE}"

          // Project-type-aware effective parameters
          env.EFFECTIVE_TIMEOUT = params.TIMEOUT_MINUTES?.trim() ? params.TIMEOUT_MINUTES.trim() : '120'
          env.EFFECTIVE_MAX_PARALLEL = params.MAX_PARALLEL_SESSIONS?.trim() ? params.MAX_PARALLEL_SESSIONS.trim() : '1'

          if (params.PROJECT_TYPE == 'TS') {
            echo "TS run selected: Using TIMEOUT_MINUTES as runtime duration"
          }
          if (params.PROJECT_TYPE == 'JAVA') {
            echo "JAVA run selected: Using TIMEOUT_MINUTES as timeout duration"
          }
          if (!(env.EFFECTIVE_TIMEOUT ==~ /\d+/)) {
            error("TIMEOUT_MINUTES must be a positive integer")
          }
          if (!(env.EFFECTIVE_MAX_PARALLEL ==~ /\d+/)) {
            error("MAX_PARALLEL_SESSIONS must be a positive integer")
          }
        }
      }
    }

    stage('Prepare') {
      steps {
        bat 'if not exist "%JAVA_DIR%\\sessions" mkdir "%JAVA_DIR%\\sessions"'
        bat 'if not exist "%JAVA_DIR%\\screenshots" mkdir "%JAVA_DIR%\\screenshots"'
        bat 'if not exist "%JAVA_DIR%\\logs" mkdir "%JAVA_DIR%\\logs"'

        bat 'if not exist "%TS_DIR%\\sessions" mkdir "%TS_DIR%\\sessions"'
        bat 'if not exist "%TS_DIR%\\screenshots" mkdir "%TS_DIR%\\screenshots"'
        bat 'if not exist "%TS_DIR%\\logs" mkdir "%TS_DIR%\\logs"'
      }
    }

    stage('Java Prechecks') {
      when {
        expression { params.RUN_PRECHECKS && (params.PROJECT_TYPE == 'JAVA' || params.PROJECT_TYPE == 'BOTH') }
      }
      steps {
        dir("${env.JAVA_DIR}") {
          bat "mvn %MVN_FLAGS% clean compile"
          bat "mvn %MVN_FLAGS% -DskipTests package"
        }
      }
    }

    stage('TS Prechecks') {
      when {
        expression { params.RUN_PRECHECKS && (params.PROJECT_TYPE == 'TS' || params.PROJECT_TYPE == 'BOTH') }
      }
      steps {
        dir("${env.TS_DIR}") {
          bat 'npm ci'
          bat 'node --check src/index.js'
          bat 'node --check src/browser/browser.js'
          bat 'node --check src/auth/login.js'
          bat 'node --check src/detection/matchDetector.js'
          bat 'node --check src/selection/seatSelector.js'
          bat 'node --check src/session/parallelController.js'
        }
      }
    }

    stage('Run Java') {
      when {
        expression { params.PROJECT_TYPE == 'JAVA' || params.PROJECT_TYPE == 'BOTH' }
      }
      steps {
        dir("${env.JAVA_DIR}") {
          bat """
            set HEADLESS=${params.HEADLESS_MODE}
            set MAX_PARALLEL_SESSIONS=${env.EFFECTIVE_MAX_PARALLEL}
            mvn %MVN_FLAGS% exec:java -Dexec.mainClass=com.ticketautomation.TicketAutomationApplication -Dexec.jvmArgs=\"-Xmx2g -Xms512m\" -Dtimeout=${env.EFFECTIVE_TIMEOUT} -DmaxParallelSessions=${env.EFFECTIVE_MAX_PARALLEL}
          """
        }
      }
    }

    stage('Run TS') {
      when {
        expression { params.PROJECT_TYPE == 'TS' || params.PROJECT_TYPE == 'BOTH' }
      }
      steps {
        dir("${env.TS_DIR}") {
          bat """
            if not exist node_modules npm ci
            set HEADLESS=${params.HEADLESS_MODE}
            set TIMEOUT_MINUTES=${env.EFFECTIVE_TIMEOUT}
            set MAX_PARALLEL_SESSIONS=${env.EFFECTIVE_MAX_PARALLEL}
            npm run start
          """
        }
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: 'playwright_java_tickets/target/*.jar,playwright_java_tickets/screenshots/**/*.png,playwright_java_tickets/logs/**/*,playwright_java_tickets/sessions/**/*.json,Playwright_TS/screenshots/**/*.png,Playwright_TS/logs/**/*,Playwright_TS/sessions/**/*.json', allowEmptyArchive: true, fingerprint: true
    }
    success {
      echo '✅ Pipeline completed.'
    }
    failure {
      echo '❌ Pipeline failed. Check archived logs/screenshots.'
    }
  }
}
